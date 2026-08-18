# -*- coding: utf-8 -*-
"""Clued 测试工具箱：沙盒仓库（本地 file remote，零网络）+ Fake 提供方 + 断言。

沙盒沿用 test_acceptance.py 模式：把 sync-memory.py 复制进沙盒（脚本 REPO
自解析）；sync.config.json 设 proxy=""（跳过网络探测）+ consumer_memory_path
指向沙盒内 conform 文件；remote 为本地 bare 仓库。全部操作本地完成。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

GIT = shutil.which("git") or "git"

CONFORM_TEXT = (
    "版本真值核对：触发式（读前 ls-remote 比对）。\n"
    "触发式：仅在命中 T1–T4 或审计类任务时执行。\n"
    "禁自动化：禁止定时任务/启动加载/调度自动化。\n")

DUMMY_MEMORY_FILES = {
    "画像.md": "# 画像\n\n## 一句话\n测试\n",
    "状态.md": "# 状态\n\n## 一句话\n测试\n",
    "决策.md": "# 决策\n\n## 已确认\n- 测试\n",
    "待办.md": "# 待办\n\n- [ ] 测试\n",
    "归档.md": "# 归档\n\n测试\n",
}

INDEX_JSON = {
    "schema_version": 1,
    "files": ["画像.md", "状态.md", "决策.md", "待办.md", "归档.md"],
    "recall": {"L1": [], "L2": [], "L3": [], "L4": [], "L5": [], "L6": []},
}


def sh(cmd, cwd=None, check_fail=True, timeout=90):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    if check_fail and p.returncode != 0:
        raise AssertionError("command failed (%d): %s\nstdout:\n%s\nstderr:\n%s"
                             % (p.returncode, " ".join(cmd), p.stdout,
                                p.stderr))
    return p


def git(*args, cwd):
    return sh([GIT, "-C", cwd] + list(args))


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def make_sandbox(tmp, with_engine=True):
    """创建沙盒克隆 + 本地 bare remote。返回 repo 路径。"""
    repo = os.path.join(tmp, "repo")
    mem = os.path.join(repo, "memory")
    os.makedirs(os.path.join(mem, "objects"))
    os.makedirs(os.path.join(mem, "audit"))
    os.makedirs(os.path.join(mem, "session"))
    with open(os.path.join(mem, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(INDEX_JSON, fh, ensure_ascii=False, indent=2)
    for name, text in DUMMY_MEMORY_FILES.items():
        with open(os.path.join(mem, name), "w", encoding="utf-8") as fh:
            fh.write(text)
    with open(os.path.join(mem, "object-index.json"), "w",
              encoding="utf-8") as fh:
        json.dump({"schema_version": 1, "objects": []}, fh)
    for name in ("sync-memory.py", "guards.json", ".gitattributes",
                 ".gitignore"):
        shutil.copy(os.path.join(REPO_ROOT, name), os.path.join(repo, name))
    if with_engine:
        shutil.copy(os.path.join(REPO_ROOT, "memory.py"),
                    os.path.join(repo, "memory.py"))
        shutil.copytree(os.path.join(REPO_ROOT, "memory_engine"),
                        os.path.join(repo, "memory_engine"))
        shutil.copytree(os.path.join(REPO_ROOT, "adapters"),
                        os.path.join(repo, "adapters"))
    # sync.config.json：proxy=""（直连本地 remote，跳过网络探测）
    consumer = os.path.join(tmp, "consumer")
    os.makedirs(consumer)
    with open(os.path.join(consumer, "MEMORY.md"), "w",
              encoding="utf-8") as fh:
        fh.write(CONFORM_TEXT)
    with open(os.path.join(repo, "sync.config.json"), "w",
              encoding="utf-8") as fh:
        json.dump({
            "proxy": "",
            "repo": repo,
            "consumer_memory_path": os.path.join(consumer, "MEMORY.md"),
            "git_candidates": ["C:/Program Files/Git/bin/git.exe",
                               "C:/Program Files/Git/cmd/git.exe"],
        }, fh)
    # git 初始化
    git("init", "-b", "main", cwd=repo)
    git("config", "user.name", "CluedTest", cwd=repo)
    git("config", "user.email", "clued-test@localhost", cwd=repo)
    git("config", "core.autocrlf", "false", cwd=repo)
    git("config", "merge.union.driver",
        "git merge-file --union %A %O %B", cwd=repo)
    git("config", "maintenance.auto", "false", cwd=repo)
    git("config", "fetch.autoMaintenance", "false", cwd=repo)
    git("config", "gc.pruneExpire", "2.weeks", cwd=repo)
    git("add", ".", cwd=repo)
    git("commit", "-m", "sandbox init", cwd=repo)
    remote = os.path.join(tmp, "remote.git")
    git("init", "--bare", remote, cwd=tmp)
    git("remote", "add", "origin", remote, cwd=repo)
    git("push", "-u", "origin", "main", cwd=repo)
    # bare 仓库默认 HEAD 指向 master；固定为 main，保证 clone 检出工作树
    git("symbolic-ref", "HEAD", "refs/heads/main", cwd=remote)
    return repo


def make_controller(tmp, provider=None, with_engine=True, runtime_root=None,
                    sync=None, gitrepo=None, adapter_doc_path=True):
    """构造 Controller；engine paths 重定向到沙盒。"""
    repo = make_sandbox(tmp, with_engine=with_engine)
    from memory_engine import paths as engine_paths
    engine_paths.set_repo(repo)
    from clued.controller import Controller
    from clued.sync_provider import GitRepo, SyncProvider
    root = runtime_root or os.path.join(repo, ".clued")
    if sync is None:
        sync = SyncProvider(repo)
    if gitrepo is None:
        gitrepo = GitRepo(repo)
    if provider is None:
        from clued.auth.fake import FakeAuthProvider
        provider = FakeAuthProvider(authorized_spec())
    if adapter_doc_path is True:
        adapter_doc_path = os.path.join(REPO_ROOT, "clued", "codex_adapter.md")
    else:
        adapter_doc_path = None
    from clued.controller import _make_memory_doctor
    ctrl = Controller(repo, root, provider, sync, gitrepo,
                      adapter_doc_path=adapter_doc_path,
                      memory_doctor=_make_memory_doctor(repo))
    return ctrl


def authorized_spec():
    return {
        "outcomes": [{"kind": "AUTHORIZED",
                      "account_id": "github:testuser",
                      "scopes": ["memory:read", "memory:write",
                                 "sync:request"],
                      "subject": "testuser"}],
        "revoke": {"ok": True, "remote_confirmed": True},
    }


def unavailable_spec(reason="network"):
    return {
        "outcomes": [{"kind": "UNAVAILABLE", "reason": reason,
                      "detail": "test unavailable"}],
        "revoke": {"ok": False, "reason": "network"},
    }


def denied_spec(reason="forbidden"):
    return {
        "outcomes": [{"kind": "DENIED", "reason": reason,
                      "detail": "test denied"}],
        "revoke": {"ok": False, "reason": reason},
    }


def tls_spec():
    return {
        "outcomes": [{"kind": "DENIED_SECURITY", "reason": "tls",
                      "detail": "certificate verify failed"}],
        "revoke": {"ok": False, "reason": "tls"},
    }
