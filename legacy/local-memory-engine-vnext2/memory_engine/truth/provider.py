# -*- coding: utf-8 -*-
"""R3-T02 Repository Truth Provider（ADR-R3-002 §4 现场核验算法）。

设计约束（Gate 1 裁决）：
- 核验路径**不依赖持久 remote-tracking ref**（refs/remotes/**）：remote 值一律
  取自 `git ls-remote origin main` 现场输出，ahead/behind 直接用远端 sha 计算
  （`git rev-list --left-right --count HEAD...<sha>`），避免 ENV-DEFECT-001；
- 禁止用 Python 直写 refs/remotes/** 作为正式方案；
- 独立状态文件写 `.truth-state/`（自定义目录，不触碰 .git/refs），仅用于
  LKG/最后核验证据留存，不作为 current 事实来源；
- 无法取远端 → 对应 claim 标 UNVERIFIED + REASON（远端不可达时只报告
  "最后一次已验证状态"，见 ADR-R3-002 §4.5）。
"""

import json
import os
import subprocess

from . import schema


class RepositoryTruthError(Exception):
    """Provider 稳定错误（携带 reason code）。"""

    def __init__(self, reason, detail=""):
        super(RepositoryTruthError, self).__init__("%s: %s" % (reason, detail))
        self.reason = reason
        self.detail = detail


class RepositoryTruthProvider(object):
    """对单一仓库执行现场核验并产出 claims（未绑定 receipt 的裸事实）。"""

    def __init__(self, repo_path, git_bin=None, state_dir=None, timeout=30):
        self.repo = os.path.abspath(repo_path)
        self.git = git_bin or ("git" if os.name != "nt" else "git")
        # 独立状态目录（LKG 证据留存），默认 <repo>/.truth-state
        self.state_dir = state_dir or os.path.join(self.repo, ".truth-state")
        self.timeout = timeout

    # ---- git 执行（隔离） ----
    def _run(self, args, check=True):
        cmd = [self.git, "-C", self.repo] + list(args)
        try:
            p = subprocess.run(cmd, capture_output=True, text=True,
                               encoding="utf-8", errors="replace",
                               timeout=self.timeout)
        except subprocess.TimeoutExpired:
            raise RepositoryTruthError("GIT_FAILED", "git 超时: %s" % " ".join(args[:3]))
        if p.returncode != 0:
            if check:
                raise RepositoryTruthError(
                    "GIT_FAILED", "%s -> %s" % (" ".join(args[:3]),
                                                (p.stderr or p.stdout or "").strip()[:200]))
            return None
        return (p.stdout or "").strip()

    # ---- 现场取证 ----
    def local_head(self):
        out = self._run(["rev-parse", "HEAD"], check=False)
        if out is None or len(out) != 40:
            raise RepositoryTruthError("NO_LOCAL_REPO", "HEAD 不可读")
        return out

    def local_branch(self):
        out = self._run(["symbolic-ref", "--short", "-q", "HEAD"], check=False)
        return out or "(detached)"

    def remote_head(self):
        """ls-remote origin main（不依赖 tracking ref）。不可达 → UNVERIFIED 语义。"""
        out = self._run(["ls-remote", "origin", "main"], check=False)
        if not out:
            return None
        parts = out.split()
        return parts[0] if parts else None

    def topology(self):
        """受限 topology：tags + 远端分支名（不取全量对象图）。"""
        tags = self._run(["tag", "--list"], check=False) or ""
        branches = self._run(["ls-remote", "--heads", "origin"], check=False) or ""
        return {
            "tags": [t for t in tags.splitlines() if t],
            "remote_heads": [l.split("\t")[1] for l in branches.splitlines()
                             if "\t" in l],
        }

    def worktree(self):
        out = self._run(["status", "--porcelain"], check=False) or ""
        lines = [l for l in out.splitlines() if l]
        tracked_modified = [l for l in lines if not l.startswith("??")]
        untracked = [l[3:] for l in lines if l.startswith("??")]
        return {
            "modified_tracked": len(tracked_modified),
            "untracked": untracked,
            # clean = 无 tracked 修改 且 无 untracked（如实反映全部改动）
            "clean": len(tracked_modified) == 0 and len(untracked) == 0,
        }

    def ahead_behind(self, remote_sha=None):
        """本地 vs 远端 sha（直传 sha，不依赖 refs/remotes）。"""
        rh = remote_sha or self.remote_head()
        if not rh:
            raise RepositoryTruthError("NO_REMOTE", "remote_head 不可得")
        out = self._run(["rev-list", "--left-right", "--count", "HEAD...%s" % rh],
                        check=False)
        if not out:
            raise RepositoryTruthError("GIT_FAILED", "rev-list 无输出")
        parts = out.split()
        if len(parts) != 2:
            raise RepositoryTruthError("GIT_FAILED", "rev-list 输出异常: %s" % out)
        return {"ahead": int(parts[0]), "behind": int(parts[1]),
                "remote_sha": rh, "local_sha": self.local_head()}

    def product_version(self):
        v = os.path.join(self.repo, "VERSION")
        if os.path.isfile(v):
            with open(v, "r", encoding="utf-8") as f:
                return f.read().strip()
        return None

    # ---- claim 产出（现场快照） ----
    def snapshot(self, claim_types=None):
        """按需取现场 claims（dict claim_type → {value, evidence}）。

        默认取全部 current 类；远端不可达时 REPO_REMOTE_HEAD /
        REPO_PUSH_STATUS 返回 UNVERIFIED 语义（value=None, reason=...）。
        """
        requested = claim_types or [ct for ct, k in schema.DEFAULT_FACT_KIND.items()
                                    if k in ("current", "mixed")]
        claims = {}
        for ct in requested:
            try:
                claims[ct] = self._snapshot_one(ct)
            except RepositoryTruthError as e:
                claims[ct] = {"value": None, "status": schema.VERDICT_UNVERIFIED,
                              "reason": e.reason, "detail": e.detail}
        return claims

    def _snapshot_one(self, ct):
        if ct == "REPO_LOCAL_HEAD":
            return {"value": self.local_head(), "evidence": "git rev-parse HEAD"}
        if ct == "REPO_REMOTE_HEAD":
            rh = self.remote_head()
            if not rh:
                return {"value": None, "status": schema.VERDICT_UNVERIFIED,
                        "reason": "REMOTE_UNREACHABLE"}
            return {"value": rh, "evidence": "git ls-remote origin main"}
        if ct == "REPO_TOPOLOGY":
            return {"value": self.topology(), "evidence": "git tag --list + ls-remote --heads"}
        if ct == "REPO_WORKTREE":
            return {"value": self.worktree(), "evidence": "git status --porcelain"}
        if ct == "REPO_PUSH_STATUS":
            rh = self.remote_head()
            if not rh:
                return {"value": None, "status": schema.VERDICT_UNVERIFIED,
                        "reason": "REMOTE_UNREACHABLE"}
            return {"value": self.ahead_behind(rh), "evidence": "git rev-list --left-right --count"}
        if ct == "PRODUCT_VERSION":
            return {"value": self.product_version(), "evidence": "VERSION file"}
        raise RepositoryTruthError("UNKNOWN", "claim type not supported: %s" % ct)

    # ---- LKG 证据留存（独立状态文件，非 current 事实源） ----
    def save_lkg(self, payload):
        os.makedirs(self.state_dir, exist_ok=True)
        path = os.path.join(self.state_dir, "last-known-good.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)  # 原子替换（自定义目录，非 .git/refs）
        return path

    def load_lkg(self):
        path = os.path.join(self.state_dir, "last-known-good.json")
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
