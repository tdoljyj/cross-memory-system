#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-T02 RepositoryTruthProvider 测试（ADR-R3-002 §4）。

关键断言：provider 的核验路径**不依赖 refs/remotes 持久写**
（remote 值取 ls-remote 现场输出，ahead/behind 直算远端 sha）——
因此即使本机存在 ENV-DEFECT-001，provider 必须仍然工作。

运行：python tests/test_truth_provider.py
"""

import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import schema as TS  # noqa: E402
from memory_engine.truth import RepositoryTruthProvider  # noqa: E402

TESTS = []
GIT = "git"


def _run(cmd, cwd=None, check=True):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=60)
    if check and p.returncode != 0:
        raise AssertionError("git 失败: %s %s" % (" ".join(cmd[:3]), p.stderr[:200]))
    return p


def _make_repo():
    """临时 bare remote + seed 提交 + clone。返回 (base_tmp, remote, clone, seed_head)。"""
    tmp = tempfile.mkdtemp(prefix="truth-provider-")
    remote = os.path.join(tmp, "remote.git")
    _run([GIT, "init", "--bare", "-b", "main", remote])
    seed = os.path.join(tmp, "seed")
    _run([GIT, "clone", remote, seed])
    _run([GIT, "-C", seed, "config", "user.email", "t@t"])
    _run([GIT, "-C", seed, "config", "user.name", "t"])
    with open(os.path.join(seed, "f.txt"), "w") as f:
        f.write("hi")
    _run([GIT, "-C", seed, "add", "f.txt"])
    _run([GIT, "-C", seed, "commit", "-qm", "c1"])
    _run([GIT, "-C", seed, "tag", "v1.0"])
    _run([GIT, "-C", seed, "push", "-q", "origin", "main", "--tags"])
    head = _run([GIT, "-C", seed, "rev-parse", "HEAD"]).stdout.strip()
    clone = os.path.join(tmp, "clone")
    _run([GIT, "clone", remote, clone])
    return tmp, remote, clone, head


def _cleanup(tmp):
    shutil.rmtree(tmp, ignore_errors=True)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


@register
def test_local_head_and_branch():
    tmp, _, clone, _ = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        head = p.local_head()
        _check(len(head) == 40, "HEAD 40 位")
        _check(p.local_branch() == "main", "branch=main")
    finally:
        _cleanup(tmp)


@register
def test_remote_head_from_ls_remote():
    tmp, _, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        rh = p.remote_head()
        _check(rh == seed_head, "remote_head 应等于 seed HEAD")
        _check(p.local_head() == seed_head, "clone HEAD == seed HEAD")
    finally:
        _cleanup(tmp)


@register
def test_ahead_behind_direct_sha_no_tracking_ref():
    tmp, remote, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        ab = p.ahead_behind(seed_head)
        _check(ab["ahead"] == 0 and ab["behind"] == 0, "应 0/0")
        # 故意删除 refs/remotes（模拟 ENV-DEFECT-001 下无 tracking ref），仍可核验
        import shutil as _sh
        _sh.rmtree(os.path.join(clone, ".git", "refs", "remotes"), ignore_errors=True)
        ab2 = p.ahead_behind(seed_head)
        _check(ab2["ahead"] == 0 and ab2["behind"] == 0,
               "无 tracking ref 时 ahead/behind 仍应可算")
    finally:
        _cleanup(tmp)


@register
def test_worktree_snapshot():
    tmp, _, clone, _ = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        wt = p.worktree()
        _check(wt["clean"] is True, "clone 应 clean")
        with open(os.path.join(clone, "dirty.txt"), "w") as f:
            f.write("x")
        wt2 = p.worktree()
        _check(wt2["clean"] is False, "dirty 应检出")
        _check(len(wt2["untracked"]) >= 1, "应列出 untracked")
    finally:
        _cleanup(tmp)


@register
def test_topology_limited():
    tmp, _, clone, _ = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        topo = p.topology()
        _check("v1.0" in topo["tags"], "tags 应含 v1.0")
        _check(any("refs/heads/main" in h for h in topo["remote_heads"]),
               "remote_heads 应含 main")
    finally:
        _cleanup(tmp)


@register
def test_snapshot_claims_current():
    tmp, _, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        claims = p.snapshot(["REPO_LOCAL_HEAD", "REPO_REMOTE_HEAD",
                             "REPO_PUSH_STATUS", "REPO_WORKTREE"])
        _check(claims["REPO_LOCAL_HEAD"]["value"] == seed_head, "LOCAL_HEAD 值")
        _check(claims["REPO_REMOTE_HEAD"]["value"] == seed_head, "REMOTE_HEAD 值")
        _check(claims["REPO_PUSH_STATUS"]["value"]["ahead"] == 0, "PUSH_STATUS 0/0")
        _check(claims["REPO_WORKTREE"]["value"]["clean"] is True, "WORKTREE clean")
    finally:
        _cleanup(tmp)


@register
def test_remote_unreachable_returns_unverified():
    tmp, _, clone, _ = _make_repo()
    try:
        # 把 origin 指向不可达地址
        _run([GIT, "-C", clone, "remote", "set-url", "origin",
              "http://127.0.0.1:1/definitely-not-there.git"])
        p = RepositoryTruthProvider(clone)
        rh = p.remote_head()
        _check(rh is None, "不可达应返回 None")
        claims = p.snapshot(["REPO_REMOTE_HEAD", "REPO_PUSH_STATUS"])
        _check(claims["REPO_REMOTE_HEAD"]["status"] == TS.VERDICT_UNVERIFIED,
               "REMOTE_HEAD 应 UNVERIFIED")
        _check(claims["REPO_REMOTE_HEAD"]["reason"] == "REMOTE_UNREACHABLE",
               "reason 应为 REMOTE_UNREACHABLE")
        # 本地 claim 仍可 VERIFIED（本地取证独立于远端）
        claims2 = p.snapshot(["REPO_LOCAL_HEAD"])
        _check(claims2["REPO_LOCAL_HEAD"]["value"] is not None, "LOCAL_HEAD 仍可读")
    finally:
        _cleanup(tmp)


@register
def test_lkg_state_file_independent():
    tmp, _, clone, _ = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        path = p.save_lkg({"local": "x", "note": "lkg"})
        _check(os.path.isfile(path), "LKG 文件应落盘")
        _check(os.path.dirname(path).endswith(".truth-state"), "LKG 在独立状态目录")
        loaded = p.load_lkg()
        _check(loaded["local"] == "x", "LKG 读回")
        # 独立状态目录不触碰 .git/refs
        _check(not os.path.exists(os.path.join(clone, ".git", "refs", "remotes", "origin", "envprobe")),
               "不得写 refs/remotes")
    finally:
        _cleanup(tmp)


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
