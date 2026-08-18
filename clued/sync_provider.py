# -*- coding: utf-8 -*-
"""Sync Provider（协议 §4.1 / §10）。

调用既有 `sync-memory.py` 的 pull/push/doctor/bootstrap 能力（vNext-1.3
稳定基线，不修改、不绕过、不复制其逻辑）。认证平面与同步平面解耦（§4.3）：
本模块不接触凭据、不做授权判定。

- 子进程方式调用：`python sync-memory.py <mode> [access]`；
- 超时有界（默认 120s，可配置）；输出经 redact；
- git 写操作统一经同步脚本（禁止本模块直接 push/fetch）。
"""

import os
import subprocess
import sys

from .errors import CluedError
from .redact import redact

DEFAULT_SYNC_TIMEOUT_S = 120.0
DEFAULT_PROBE_TIMEOUT_S = 5.0


class SyncResult(object):
    def __init__(self, mode, returncode, stdout, stderr, timed_out=False):
        self.mode = mode
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        self.timed_out = timed_out

    @property
    def ok(self):
        return (not self.timed_out) and self.returncode == 0

    def combined(self):
        return redact("\n".join([self.stdout or "", self.stderr or ""]))


class SyncProvider(object):
    """同步平面。子进程调用 sync-memory.py（REPO 由脚本自身解析）。"""

    def __init__(self, repo, script="sync-memory.py", python=None,
                 timeout_s=None, probe_timeout_s=None, run=subprocess.run,
                 proxy_alive=None):
        self.repo = os.path.abspath(os.path.expanduser(repo))
        self.script = script
        self.python = python or sys.executable
        self.timeout_s = timeout_s or DEFAULT_SYNC_TIMEOUT_S
        self.probe_timeout_s = probe_timeout_s or DEFAULT_PROBE_TIMEOUT_S
        self._run = run
        self._proxy_alive = proxy_alive  # 测试注入；None=不探测（交脚本自理）

    def _cmd(self, mode, access=None):
        argv = [self.python, self.script, mode]
        if access is not None:
            argv.append(access)
        return argv

    def _invoke(self, mode, access=None, timeout_s=None):
        argv = self._cmd(mode, access)
        if self._proxy_alive is not None and not self._proxy_alive():
            return SyncResult(mode, 1, "", "proxy unavailable", False)
        try:
            p = self._run(
                argv, cwd=self.repo, capture_output=True, text=True,
                encoding="utf-8", errors="replace",
                timeout=timeout_s or self.timeout_s)
            return SyncResult(mode, p.returncode, p.stdout or "",
                              p.stderr or "")
        except subprocess.TimeoutExpired:
            return SyncResult(mode, 1, "", "sync timeout", timed_out=True)
        except OSError as exc:
            return SyncResult(mode, 1, "", "sync spawn failed: %s" % exc)

    def pull(self, access=None):
        return self._invoke("pull", access)

    def push(self):
        return self._invoke("push")

    def doctor(self):
        return self._invoke("doctor")

    def bootstrap(self):
        return self._invoke("bootstrap")

    def require_sync_script(self):
        script_path = os.path.join(self.repo, self.script)
        if not os.path.isfile(script_path):
            raise CluedError(
                "CLD-SYNC-001", "同步脚本不存在: %s" % script_path)
        return script_path

    def require_ok(self, result, fail_code="CLD-SYNC-002"):
        if not result.ok:
            raise CluedError(
                fail_code, "同步操作 %s 失败: %s"
                % (result.mode, (result.combined() or "").strip()[-400:]),
                data={"sync_output": result.combined()[-2000:]})
        return result


class GitRepo(object):
    """只读 git 访问 + 本地提交（协议 §10.2 CHECK_OPTIMISTIC_LOCKS /
    PUSH_VIA_EXISTING_SYNC_LAYER 之前的使用方提交职责）。

    - 只读：head / blob / ls-remote / is-ancestor / status；
    - 写：仅 `commit`（add 指定文件 + 身份提交）；pull/push/fetch 一律经
      sync-memory.py（禁止绕过同步层，§10.2）。
    """

    def __init__(self, repo, git="git", run=subprocess.run):
        self.repo = os.path.abspath(repo)
        self.git = git
        self._run = run

    def _run_git(self, argv, timeout_s=60.0, check=False):
        try:
            p = self._run(
                [self.git, "-C", self.repo] + argv, capture_output=True,
                text=True, encoding="utf-8", errors="replace",
                timeout=timeout_s)
        except subprocess.TimeoutExpired:
            raise CluedError("CLD-SYNC-002", "git 操作超时: %s" % " ".join(argv))
        except OSError as exc:
            raise CluedError("CLD-SYNC-002", "git 不可用: %s" % exc)
        if check and p.returncode != 0:
            raise CluedError(
                "CLD-SYNC-002", "git 失败: %s\n%s"
                % (" ".join(argv), redact(p.stderr or "")[:400]))
        return p

    def head_sha(self):
        p = self._run_git(["rev-parse", "HEAD"])
        return (p.stdout or "").strip() or None

    def fetch_head(self, remote="origin", branch="main"):
        """只读 fetch（更新 FETCH_HEAD，不改工作树、不写远端）。

        仅用于冲突取证与远端内容校验；一切树变更与 push 经 sync-memory.py。
        """
        p = self._run_git(["fetch", remote, branch])
        if p.returncode != 0:
            raise CluedError("CLD-SYNC-002", "fetch 失败: %s"
                             % redact((p.stderr or "")[:300]))
        p2 = self._run_git(["rev-parse", "FETCH_HEAD"])
        return (p2.stdout or "").strip() or None

    def blob_sha(self, relpath):
        """HEAD 处文件的 blob sha；不存在返回 None。

        注意：git rev-parse 对不存在的路径会把输入原样回显到 stdout 并
        以非零退出，因此必须校验 returncode。
        """
        rel = relpath.replace("\\", "/")
        p = self._run_git(["rev-parse", "HEAD:%s" % rel])
        if p.returncode != 0:
            return None
        return (p.stdout or "").strip() or None

    def blob_at_ref(self, ref, relpath):
        """任意 ref 处文件内容（bytes）；不存在返回 None。"""
        rel = relpath.replace("\\", "/")
        p = self._run_git(["show", "%s:%s" % (ref, rel)])
        if p.returncode != 0:
            return None
        return p.stdout

    def blob_at_head(self, relpath):
        """HEAD 处文件内容（bytes）；不存在返回 None。"""
        return self.blob_at_ref("HEAD", relpath)

    def blob_sha_matches(self, relpath, sha_hex):
        if sha_hex is None:
            return self.blob_sha(relpath) is None
        blob = self.blob_at_head(relpath)
        if blob is None:
            return False
        import hashlib
        return hashlib.sha256(blob.encode("utf-8")).hexdigest() == sha_hex

    def is_ancestor(self, a, b):
        p = self._run_git(["merge-base", "--is-ancestor", a, b])
        return p.returncode == 0

    def remote_head(self, remote="origin", branch="main"):
        p = self._run_git(["ls-remote", remote, branch])
        line = (p.stdout or "").strip().splitlines()
        return line[0].split()[0] if line else None

    def status_porcelain(self):
        # 显式 =v1：部分 git 版本对裸 --porcelain 的输出列宽不稳定
        p = self._run_git(["status", "--porcelain=v1"])
        return (p.stdout or "").strip()

    def restore_paths(self, relpaths):
        """`git restore -- <paths>`：把指定已跟踪路径恢复为 HEAD 内容。

        仅用于回滚 Clued 自己的 replay 残留/提交（调用前必须确认工作树
        干净或脏文件全部属于 Clued replay 产物，绝不清理用户工作）。
        """
        rels = [r.replace("\\", "/") for r in relpaths if r]
        if not rels:
            return
        self._run_git(["restore", "--"] + rels, check=True)

    def reset_soft_undo_commit(self, expected_sha):
        """回滚 Clued 自己的未推送 replay 提交。

        前置校验 HEAD == expected_sha（绝不回滚他人提交）；随后
        `git reset --soft HEAD~1` + 取消暂存（工作树内容保留，由调用方
        精确 restore/删除）。返回回滚后的 HEAD。
        """
        head = self.head_sha()
        if not head or head != expected_sha:
            raise CluedError(
                "CLD-SYNC-003",
                "提交回滚前置校验失败：HEAD 已变化（拒绝回滚）")
        p = self._run_git(["rev-parse", "HEAD~1"])
        if p.returncode != 0:
            raise CluedError(
                "CLD-SYNC-003", "提交回滚失败：HEAD 无父提交（拒绝回滚）")
        self._run_git(["reset", "--soft", "HEAD~1"], check=True)
        self._run_git(["reset"], check=True)  # 取消暂存，保留工作树
        return self.head_sha()

    def commit_paths(self, relpaths, message, name, email, allow_empty=False):
        """add 指定文件 + 身份提交；不 push。"""
        for rel in relpaths:
            self._run_git(["add", "--", rel], check=True)
        argv = ["-c", "user.name=%s" % name, "-c", "user.email=%s" % email,
                "commit", "-m", message]
        if allow_empty:
            argv.append("--allow-empty")
        p = self._run_git(argv)
        if p.returncode != 0:
            if "nothing to commit" in (p.stdout or "") + (p.stderr or ""):
                return None
            raise CluedError(
                "CLD-SYNC-003", "commit 失败: %s"
                % redact((p.stderr or "")[:400]))
        return self.head_sha()
