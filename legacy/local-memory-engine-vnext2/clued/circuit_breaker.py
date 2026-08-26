# -*- coding: utf-8 -*-
"""Circuit Breaker（协议 §8）。

- 状态：CLOSED / OPEN / HALF_OPEN（§8.2）；
- 认证熔断：会话认证总预算耗尽仍 UNAVAILABLE → OPEN（§8.3.1）；
- 同步熔断：连续 2 次同步暂时失败 → OPEN（§8.3.2）；
- OPEN 初始冷却 2 分钟；连续探测失败指数增长，最大 15 分钟（§8.3.3-4）；
- 每个 Binding/Provider 同一时间最多一个 HALF_OPEN 请求（单飞，§8.3.5）；
- 用户手动同步触发一次受控探测，受单飞锁与速率限制（§8.3.6）；
- 禁止无限 while-loop、固定秒级轮询（§8.4 禁）。
"""

import os
import time

from .audit import EVENT_TYPES
from .locking import CrossProcessLock

CLOSED = "CLOSED"
OPEN = "OPEN"
HALF_OPEN = "HALF_OPEN"

INITIAL_COOLDOWN_S = 120.0      # 2 分钟
MAX_COOLDOWN_S = 900.0          # 15 分钟
MANUAL_PROBE_MIN_INTERVAL_S = 30.0  # 手动探测速率限制
SYNC_FAILURE_THRESHOLD = 2     # 连续 2 次同步暂时失败


class CircuitBreaker(object):
    """双用途熔断器。状态持久化在 state/runtime.json（由 Controller 保存）。"""

    def __init__(self, name, audit=None, binding_id="", paths=None,
                 now=time.time):
        self.name = name          # "auth" | "sync"
        self.audit = audit
        self.binding_id = binding_id
        self.paths = paths        # RuntimePaths（单飞锁用）
        self._now = now
        self.state = CLOSED
        self.consecutive_failures = 0
        self.opened_at = None
        self.cooldown_s = INITIAL_COOLDOWN_S
        self.last_probe_at = None
        self.last_failure_at = None

    # ---- 持久化 ----
    def to_dict(self):
        return {
            "state": self.state,
            "consecutive_failures": self.consecutive_failures,
            "opened_at": self.opened_at,
            "cooldown_s": self.cooldown_s,
            "last_probe_at": self.last_probe_at,
            "last_failure_at": self.last_failure_at,
        }

    @classmethod
    def from_dict(cls, d, name, audit=None, binding_id="", paths=None,
                  now=time.time):
        b = cls(name, audit=audit, binding_id=binding_id, paths=paths, now=now)
        if not isinstance(d, dict):
            return b
        b.state = d.get("state", CLOSED)
        b.consecutive_failures = int(d.get("consecutive_failures") or 0)
        b.opened_at = d.get("opened_at")
        b.cooldown_s = float(d.get("cooldown_s") or INITIAL_COOLDOWN_S)
        b.last_probe_at = d.get("last_probe_at")
        b.last_failure_at = d.get("last_failure_at")
        return b

    def _emit(self, event, result_code=""):
        if self.audit is not None and event in EVENT_TYPES:
            self.audit.append(
                event, binding_id=self.binding_id, result_code=result_code,
                metadata={"breaker": self.name, "state": self.state,
                          "cooldown_s": self.cooldown_s})

    # ---- 状态机 ----
    def allow_request(self, manual=False):
        """是否允许发起一次网络请求。

        - CLOSED：允许；
        - OPEN：默认拒绝；冷却期已过 → 进入 HALF_OPEN（单飞）；
        - HALF_OPEN：只允许一个探测请求（单飞锁）。
        手动探测（用户显式请求）：受单飞锁 + 速率限制，但不受冷却期阻塞。
        """
        now = self._now()
        if self.state == CLOSED:
            return True
        if manual:
            if self.last_probe_at and \
                    now - self.last_probe_at < MANUAL_PROBE_MIN_INTERVAL_S:
                return False  # 速率限制：连续点击不得绕过
            return self._acquire_probe(now)
        if self.state == OPEN:
            if self.opened_at is not None and \
                    now - self.opened_at >= self.cooldown_s:
                return self._acquire_probe(now)
            return False
        # HALF_OPEN：同一时间最多一个探测（单飞）
        return self._acquire_probe(now)

    def _acquire_probe(self, now):
        if self.paths is None:
            if self.state == HALF_OPEN and self.last_probe_at is not None:
                return False
            self.state = HALF_OPEN
            self.last_probe_at = now
            self._emit("breaker_half_open")
            return True
        lock_path = os.path.join(
            self.paths.locks_dir(), "probe-%s-%s.lock" % (self.name,
                                                          self.binding_id))
        lock = CrossProcessLock(lock_path)
        if not lock.acquire():
            return False  # 已有 HALF_OPEN 探测在飞
        # 拿到单飞锁 → 进入 HALF_OPEN；锁随进程结束自动失效（PID 探活回收）
        self._probe_lock = lock
        self.state = HALF_OPEN
        self.last_probe_at = now
        self._emit("breaker_half_open")
        return True

    def record_success(self):
        if self.state != CLOSED:
            self.state = CLOSED
            self.consecutive_failures = 0
            self.opened_at = None
            self.cooldown_s = INITIAL_COOLDOWN_S
            self._emit("breaker_close", "OK")
        self._release_probe()

    def record_failure(self, temporary=True):
        """temporary=False 表示明确拒绝/永久错误（不算网络暂时失败，不触发熔断）。"""
        if temporary:
            self.consecutive_failures += 1
            self.last_failure_at = self._now()
            threshold = SYNC_FAILURE_THRESHOLD
            if self.state == HALF_OPEN or self.state == OPEN:
                threshold = 1
            if self.state == OPEN or self.consecutive_failures >= threshold:
                self._open(now=self._now())
        self._release_probe()

    def force_open(self, now=None):
        self._open(now=now or self._now())
        self._release_probe()

    def _open(self, now=None):
        now = now or self._now()
        if self.state == OPEN:
            # 已打开：连续探测失败 → 指数增长冷却
            self.cooldown_s = min(self.cooldown_s * 2.0, MAX_COOLDOWN_S)
        else:
            self.cooldown_s = INITIAL_COOLDOWN_S
        self.state = OPEN
        self.opened_at = now
        self._emit("breaker_open", "FAIL")

    def _release_probe(self):
        lock = getattr(self, "_probe_lock", None)
        if lock is not None:
            lock.release()
            self._probe_lock = None

    def retry_after(self):
        if self.state != OPEN or self.opened_at is None:
            return None
        remain = self.cooldown_s - (self._now() - self.opened_at)
        return max(0, int(remain))
