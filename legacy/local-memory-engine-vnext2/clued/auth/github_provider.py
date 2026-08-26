# -*- coding: utf-8 -*-
"""GitHub 参考 Auth Provider（协议 §2.3 / §6.6 / §15.1）。

- 凭据使用平台已有凭据系统（gh CLI keyring / gh credential helper），
  Clued 不接触、不落地、不打印令牌；
- 不请求用户在对话中粘贴密码/PAT/私钥/Cookie；
- 不为了安装自动扩大 GitHub scopes；
- 认证失败不循环弹出登录；
- account_id = "github:<login>"（稳定、非秘密）；
- repo scope → memory:read / memory:write / sync:request（§15.2 最小权限）。
"""

import hashlib
import os
import shutil
import subprocess

from ..identifiers import now_rfc3339
from ..redact import redact
from .provider import (
    AUTHORIZED, DENIED, DENIED_SECURITY, REASON_ACCOUNT, REASON_CAPABILITY,
    REASON_FORBIDDEN, REASON_NETWORK, REASON_SCOPE, REASON_TLS,
    REASON_UNKNOWN_RESPONSE, UNAVAILABLE, AuthProvider, AuthResult,
    RevokeResult, classify_network_error,
)

DEFAULT_REPO = "tdoljyj/cross-memory-system"
GITHUB_SCOPE_TO_MEMORY = {
    "repo": ["memory:read", "memory:write", "sync:request"],
}


def find_gh():
    gh = shutil.which("gh")
    if gh:
        return gh
    for cand in (os.path.expandvars(r"%ProgramFiles%\GitHub CLI\gh.exe"),
                 os.path.expandvars(r"%ProgramFiles(x86)%\GitHub CLI\gh.exe"),
                 os.path.expanduser("~/scoop/shims/gh.exe")):
        if os.path.isfile(cand):
            return cand
    return None


class GitHubAuthProvider(AuthProvider):
    name = "github"

    def __init__(self, repo=DEFAULT_REPO, gh_path=None,
                 run=subprocess.run):
        self.repo = repo
        self.gh = gh_path or find_gh()
        self._run = run

    def _run_cmd(self, argv, timeout_s):
        try:
            return self._run(
                argv, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=timeout_s)
        except subprocess.TimeoutExpired:
            return None
        except OSError as exc:
            fake = type("R", (), {})()
            fake.returncode = 128
            fake.stdout = ""
            fake.stderr = str(exc)
            return fake

    # ---- 在线认证 ----
    def authenticate(self, binding, timeout_op_s=5.0, timeout_connect_s=3.0):
        if not self.gh or not os.path.isfile(self.gh):
            return AuthResult(
                UNAVAILABLE, reason=REASON_CAPABILITY,
                provider=self.name, detail="gh CLI 不可用")

        # 1) 账户身份（在线调用，验证可达性与登录态）
        proc = self._run_cmd(
            [self.gh, "api", "user", "--jq", ".login"], timeout_op_s)
        if proc is None:
            return AuthResult(
                UNAVAILABLE, reason=REASON_NETWORK, provider=self.name,
                detail="gh api user 超时")
        login = (proc.stdout or "").strip()
        if proc.returncode != 0 or not login:
            reason = classify_network_error(proc.stderr or "")
            if reason == REASON_NETWORK:
                return AuthResult(
                    UNAVAILABLE, reason=REASON_NETWORK, provider=self.name,
                    detail=redact(proc.stderr or "")[:300])
            if reason == REASON_TLS:
                return AuthResult(
                    DENIED_SECURITY, reason=REASON_TLS, provider=self.name,
                    detail=redact(proc.stderr or "")[:300])
            if reason == REASON_FORBIDDEN:
                return AuthResult(
                    DENIED, reason=REASON_FORBIDDEN, provider=self.name,
                    detail="GitHub 认证失败（401/403）")
            return AuthResult(
                DENIED_SECURITY, reason=REASON_UNKNOWN_RESPONSE,
                provider=self.name, detail="GitHub 响应无法解析")

        # 2) 账户匹配（§7.4 账户不匹配 → LOCKED）
        expected = (binding.get("account_id") or "").split("github:", 1)
        expected_login = expected[1] if len(expected) == 2 else ""
        if expected_login and login != expected_login:
            return AuthResult(
                DENIED, reason=REASON_ACCOUNT, account_id="github:" + login,
                provider=self.name, detail="账户不匹配")

        # 3) scopes（本地 gh auth status 读取，不落地）
        scopes = self._token_scopes()
        memory_scopes = self._map_scopes(scopes)
        if not memory_scopes:
            return AuthResult(
                DENIED, reason=REASON_SCOPE, account_id="github:" + login,
                scopes=memory_scopes, provider=self.name,
                detail="GitHub 令牌缺少 repo scope")

        # 4) 仓库访问校验（在线）
        proc2 = self._run_cmd(
            [self.gh, "api", "repos/%s" % self.repo, "--jq", ".full_name"],
            timeout_op_s)
        if proc2 is None:
            return AuthResult(
                UNAVAILABLE, reason=REASON_NETWORK, account_id="github:" + login,
                provider=self.name, detail="gh api repo 超时")
        if proc2.returncode != 0:
            reason = classify_network_error(proc2.stderr or "")
            if reason == REASON_NETWORK:
                return AuthResult(
                    UNAVAILABLE, reason=REASON_NETWORK,
                    account_id="github:" + login, provider=self.name,
                    detail=redact(proc2.stderr or "")[:300])
            if reason == REASON_TLS:
                return AuthResult(
                    DENIED_SECURITY, reason=REASON_TLS,
                    account_id="github:" + login, provider=self.name,
                    detail=redact(proc2.stderr or "")[:300])
            return AuthResult(
                DENIED, reason=REASON_FORBIDDEN, account_id="github:" + login,
                provider=self.name, detail="无法访问 Canonical Store 仓库")

        return AuthResult(
            AUTHORIZED, account_id="github:" + login, scopes=memory_scopes,
            provider=self.name, subject=login,
            authorized_at=now_rfc3339(), detail="GitHub 在线认证成功")

    def _token_scopes(self):
        """gh auth status 的 Token scopes（进程级读取，不写环境变量/文件）。"""
        proc = self._run_cmd([self.gh, "auth", "status"], 10.0)
        if proc is None or proc.returncode != 0:
            return []
        scopes = []
        for line in (proc.stdout or "").splitlines():
            line = line.strip()
            if line.startswith("- Token scopes:"):
                for token in line.split(":", 1)[1].split(","):
                    token = token.strip().strip("'")
                    if token:
                        scopes.append(token)
        return scopes

    def _map_scopes(self, github_scopes):
        out = []
        for g, mem in GITHUB_SCOPE_TO_MEMORY.items():
            if g in github_scopes:
                out.extend(mem)
        return sorted(set(out))

    # ---- 撤销 ----
    def revoke(self, binding, timeout_op_s=5.0):
        """GitHub 认证为账户级，无逐 Binding 令牌可撤销（§12.2.6 实现限制）。

        远端撤销 = Binding 标记 REVOKED + 撤销任务登记；不触碰用户共享的
        gh 登录（会破坏其他 Binding 与用户自身使用）。
        """
        return RevokeResult(
            ok=True, remote_confirmed=False,
            reason="account_level_credential",
            detail="GitHub 认证为账户级凭据，无逐 Binding 令牌；"
                   "远端撤销由撤销队列登记执行（v0.1 无逐绑定令牌）")

    def account_id(self, binding):
        return binding.get("account_id") or ""
