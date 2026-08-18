# -*- coding: utf-8 -*-
"""FakeAuthProvider —— 故障注入/测试用 Auth Provider。

仅经 `CLUED_AUTH_PROVIDER=fake:<spec.json>` 显式启用；生产默认 github。
spec 格式：
{
  "outcomes": [ {"kind": "AUTHORIZED", "account_id": "...", "scopes": [...],
                 "subject": "...", "detail": "..."}, ... ],
  "loop": true,
  "revoke": {"ok": true, "remote_confirmed": true}
}
每次 authenticate 依序弹出 outcomes；耗尽后若 loop=true 复用最后一个，
否则持续返回最后一个。kind 支持 AUTHORIZED / DENIED / DENIED_SECURITY /
UNAVAILABLE（reason 支持 network/capability/forbidden/scope/tls…）。
"""

import json
import os

from .provider import (
    AUTHORIZED, DENIED, DENIED_SECURITY, REASON_NETWORK, UNAVAILABLE,
    AuthProvider, AuthResult, RevokeResult,
)


class FakeAuthProvider(AuthProvider):
    name = "fake"

    def __init__(self, spec, state_path=None):
        self.spec = spec or {}
        outcomes = self.spec.get("outcomes") or []
        self._outcomes = list(outcomes)
        self._state_path = state_path
        self._idx = self._load_idx()
        self.loop = bool(self.spec.get("loop", True))
        self.calls = []

    def _load_idx(self):
        if not self._state_path or not os.path.isfile(self._state_path):
            return 0
        try:
            with open(self._state_path, "r", encoding="utf-8") as fh:
                return int((json.load(fh) or {}).get("idx", 0))
        except Exception:
            return 0

    def _save_idx(self):
        if not self._state_path:
            return
        d = os.path.dirname(self._state_path)
        if d and not os.path.isdir(d):
            os.makedirs(d)
        tmp = self._state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"idx": self._idx}, fh)
        os.replace(tmp, self._state_path)

    @classmethod
    def from_spec_file(cls, path):
        with open(path, "r", encoding="utf-8") as fh:
            return cls(json.load(fh), state_path=path + ".state")

    def authenticate(self, binding, timeout_op_s=5.0, timeout_connect_s=3.0):
        if not self._outcomes:
            return AuthResult(UNAVAILABLE, reason=REASON_NETWORK,
                              provider=self.name, detail="fake: no outcomes")
        idx = min(self._idx, len(self._outcomes) - 1)
        raw = dict(self._outcomes[idx])
        self._idx += 1
        if self._idx >= len(self._outcomes) and self.loop:
            self._idx = len(self._outcomes) - 1
        self._save_idx()
        kind = raw.get("kind", AUTHORIZED)
        authorized_at = raw.get("authorized_at")
        if kind == AUTHORIZED and not authorized_at:
            from ..identifiers import now_rfc3339
            authorized_at = now_rfc3339()
        result = AuthResult(
            kind, reason=raw.get("reason", ""),
            account_id=raw.get("account_id"),
            scopes=raw.get("scopes"),
            provider=self.name, subject=raw.get("subject"),
            authorized_at=authorized_at,
            detail=raw.get("detail", "fake %s" % kind))
        self.calls.append(result.to_dict())
        return result

    def revoke(self, binding, timeout_op_s=5.0):
        raw = self.spec.get("revoke") or {}
        return RevokeResult(
            ok=bool(raw.get("ok", True)),
            reason=raw.get("reason", ""),
            detail=raw.get("detail", "fake revoke"),
            remote_confirmed=bool(raw.get("remote_confirmed", True)))

    def account_id(self, binding):
        return binding.get("account_id") or ""
