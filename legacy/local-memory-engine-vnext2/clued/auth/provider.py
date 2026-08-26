# -*- coding: utf-8 -*-
"""Auth Provider 接口（协议 §4.1 / §7）。

三值结果（§7.2）：
- AUTHORIZED：在线确认账户、Binding 和 scopes 有效；
- DENIED：401/403、Binding 撤销、账户禁用、scope 缺失、签名无效；
- DENIED_SECURITY：证书过期/主机名不匹配/信任链异常（§7.2 必判，禁止降级）；
- UNAVAILABLE：DNS、连接超时、TLS 握手超时、临时 5xx、网络不可达。

认证平面与同步平面解耦（§4.3）：本模块不 import 同步层。
"""

import abc

AUTHORIZED = "AUTHORIZED"
DENIED = "DENIED"
DENIED_SECURITY = "DENIED_SECURITY"
UNAVAILABLE = "UNAVAILABLE"

# DENIED 细分（§7.4）
REASON_FORBIDDEN = "forbidden"
REASON_REVOKED = "revoked"
REASON_SCOPE = "scope"
REASON_ACCOUNT = "account"
REASON_INTEGRITY = "integrity"
REASON_TLS = "tls"
REASON_UNKNOWN_RESPONSE = "unknown_response"
REASON_NETWORK = "network"
REASON_CAPABILITY = "capability"
REASON_BREAKER = "breaker_open"
REASON_BUDGET = "budget_exhausted"

REQUIRED_SCOPES = ("memory:read", "memory:write", "sync:request")


class AuthResult(object):
    def __init__(self, kind, reason="", account_id=None, scopes=None,
                 provider=None, subject=None, authorized_at=None,
                 detail="", exit_code=None, error_code=None):
        self.kind = kind
        self.reason = reason
        self.account_id = account_id
        self.scopes = list(scopes or [])
        self.provider = provider
        self.subject = subject
        self.authorized_at = authorized_at
        self.detail = detail          # 已脱敏
        self.exit_code = exit_code
        self.error_code = error_code

    @property
    def is_authorized(self):
        return self.kind == AUTHORIZED

    @property
    def is_denial(self):
        return self.kind in (DENIED, DENIED_SECURITY)

    @property
    def is_network_unavailable(self):
        return self.kind == UNAVAILABLE and self.reason == REASON_NETWORK

    def to_dict(self):
        return {
            "kind": self.kind,
            "reason": self.reason,
            "account_id": self.account_id,
            "scopes": self.scopes,
            "provider": self.provider,
            "authorized_at": self.authorized_at,
            "detail": self.detail,
        }


class RevokeResult(object):
    def __init__(self, ok, reason="", detail="", remote_confirmed=False):
        self.ok = ok
        self.reason = reason
        self.detail = detail
        self.remote_confirmed = remote_confirmed


class AuthProvider(abc.ABC):
    """认证平面接口。实现不得落地令牌（§15.1）。"""

    name = "base"

    @abc.abstractmethod
    def authenticate(self, binding, timeout_op_s=5.0, timeout_connect_s=3.0):
        """在线认证当前 Binding。返回 AuthResult。必须在超时内返回。"""

    @abc.abstractmethod
    def revoke(self, binding, timeout_op_s=5.0):
        """撤销当前 Binding 的远端授权（或返回登记撤销任务所需信息）。

        返回 RevokeResult；网络不可用时应返回 ok=False + reason=network
        （由卸载器登记 REMOTE_REVOCATION_PENDING，§12.3/§12.4）。
        """

    @abc.abstractmethod
    def account_id(self, binding):
        """稳定、非秘密账户标识（§5.1）。"""


def classify_network_error(err_text):
    """把底层错误文本归类为 network / tls / denied / unknown（保守默认安全错误）。

    规则（§7.2）：解析错误、未知响应、证书校验失败默认视为安全错误，
    不得笼统归为 UNAVAILABLE；其中证书类 MUST 判 DENIED_SECURITY。
    """
    t = (err_text or "").lower()
    tls_markers = ("certificate", "cert ", "ssl:", "tls", "handshake",
                   "hostname", "verify", "x509", "sec_error")
    network_markers = ("connection timed out", "timed out", "timeout",
                       "connection reset", "connection refused",
                       "network is unreachable", "network unreachable",
                       "could not resolve host", "dns", "name or service",
                       "getaddrinfo", "temporary failure", "eof",
                       "connection closed", "unable to access",
                       "failed to connect", "502", "503", "504",
                       "proxy")
    denied_markers = ("401", "403", "404", "unauthorized", "forbidden",
                      "bad credentials", "authentication failed",
                      "not found")
    if any(m in t for m in tls_markers):
        return REASON_TLS
    if any(m in t for m in denied_markers):
        return REASON_FORBIDDEN
    if any(m in t for m in network_markers):
        return REASON_NETWORK
    return REASON_UNKNOWN_RESPONSE  # 保守：未知响应按安全错误处理
