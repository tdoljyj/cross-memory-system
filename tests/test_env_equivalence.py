#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 3-C：ENV-DEFECT 规避等价测试（ADR-R3-006 执行证明）。

在临时 bare remote + 克隆上验证规避路径（等价测试，不扩大 skip、
不修改断言隐藏环境缺陷）：
- ls-remote 现场直取远端真值（不依赖 refs/remotes/*）；
- 明确 SHA 直算 ahead/behind（rev-list --left-right --count HEAD...<sha>）；
- FETCH_HEAD 读取（合并路径）；
- 独立状态文件（.truth-state 记录非 Git 运行状态，不写 refs/remotes）；
- 删除 refs/remotes/ 后核验仍工作（等价于 ENV-DEFECT-001 环境）。

运行：python tests/test_env_equivalence.py
"""

import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

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
    """临时 bare remote + seed 提交 + clone + 额外提交（制造 ahead）。"""
    tmp = tempfile.mkdtemp(prefix="env-eq-")
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
    _run([GIT, "-C", seed, "push", "-q", "origin", "main"])
    seed_head = _run([GIT, "-C", seed, "rev-parse", "HEAD"]).stdout.strip()
    clone = os.path.join(tmp, "clone")
    _run([GIT, "clone", remote, clone])
    # 制造本地领先 1 提交
    _run([GIT, "-C", clone, "config", "user.email", "t@t"])
    _run([GIT, "-C", clone, "config", "user.name", "t"])
    with open(os.path.join(clone, "local.txt"), "w") as f:
        f.write("local")
    _run([GIT, "-C", clone, "add", "local.txt"])
    _run([GIT, "-C", clone, "commit", "-qm", "local-c1"])
    return tmp, remote, clone, seed_head


def register(fn):
    TESTS.append(fn)
    return fn


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


@register
def test_ls_remote_direct_truth():
    """ls-remote 现场直取远端真值（唯一 current 事实源）。"""
    tmp, _remote, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        rh = p.remote_head()
        _check(rh == seed_head, "ls-remote 直取 = seed HEAD")
        _check(p.local_head() != rh, "本地已领先")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_ahead_behind_explicit_sha_no_tracking_ref():
    """明确 SHA 直算 ahead/behind（不依赖 refs/remotes/*）。"""
    tmp, _remote, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        ab = p.ahead_behind(seed_head)
        _check(ab["ahead"] == 1 and ab["behind"] == 0,
               "ahead/behind=1/0（本地领先 1 提交）")
        # 删除 refs/remotes（模拟 ENV-DEFECT-001：tracking ref 无法落盘）
        shutil.rmtree(os.path.join(clone, ".git", "refs", "remotes"),
                      ignore_errors=True)
        ab2 = p.ahead_behind(seed_head)
        _check(ab2["ahead"] == 1 and ab2["behind"] == 0,
               "无 refs/remotes 时仍可直算（等价规避证明）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_fetch_head_readable_after_fetch():
    """FETCH_HEAD 读取（合并路径；普通文件可写可读，非 refs/remotes）。"""
    tmp, remote, clone, _seed_head = _make_repo()
    try:
        _run([GIT, "-C", clone, "fetch", "-q", "origin", "main"])
        fh = os.path.join(clone, ".git", "FETCH_HEAD")
        _check(os.path.isfile(fh), "FETCH_HEAD 落盘")
        content = open(fh, encoding="utf-8", errors="replace").read()
        _check(len(content.strip()) > 0, "FETCH_HEAD 内容非空")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_independent_state_file_no_ref_write():
    """独立状态文件（.truth-state）记录非 Git 状态，不写 refs/remotes。"""
    tmp, _remote, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        path = p.save_lkg({"local": p.local_head(),
                           "remote": p.remote_head(),
                           "ts": "x"})
        _check(os.path.isfile(path), "独立状态文件落盘")
        _check(os.path.dirname(path).endswith(".truth-state"), "位于 .truth-state")
        # 不写 refs/remotes
        refs_remotes = os.path.join(clone, ".git", "refs", "remotes")
        _check(not os.path.exists(os.path.join(refs_remotes, "origin", "main"))
               if os.path.isdir(refs_remotes) else True,
               "未写 refs/remotes/origin/main")
        loaded = p.load_lkg()
        _check(loaded["local"] == p.local_head(), "LKG 读回一致")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_remote_unreachable_reports_last_known():
    """远端不可达 → 只报告 LKG（最后一次已验证状态），不编造当前值。"""
    tmp, _remote, clone, seed_head = _make_repo()
    try:
        p = RepositoryTruthProvider(clone)
        p.save_lkg({"local": p.local_head(), "remote": seed_head,
                    "last_verified": "x"})
        _run([GIT, "-C", clone, "remote", "set-url", "origin",
              "http://127.0.0.1:1/nope.git"])
        rh = p.remote_head()
        _check(rh is None, "不可达 → None（UNVERIFIED 语义）")
        claims = p.snapshot(["REPO_REMOTE_HEAD"])
        _check(claims["REPO_REMOTE_HEAD"]["status"] == "CURRENT_STATE_UNVERIFIED",
               "UNVERIFIED 状态")
        lkg = p.load_lkg()
        _check(lkg["remote"] == seed_head, "LKG 保留最后一次已验证状态")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_no_python_ref_fabrication():
    """规避路径不使用 Python 直写/伪造 remote ref（代码面断言）。"""
    src = open(os.path.join(REPO_ROOT, "memory_engine", "truth",
                            "provider.py"), encoding="utf-8").read()
    # 不得调用 git update-ref（写 ref 的唯一合法途径是 git 工具本身，且本项目不用）
    _check("update-ref" not in src, "provider 不调用 git update-ref")
    # 不得出现 Python 写 refs 的辅助（write_ref 语义）
    _check("write_ref" not in src, "provider 无 write_ref 辅助")
    # 远端真值一律来自 ls-remote 输出（现场直取）
    _check("ls-remote" in src, "provider 使用 ls-remote 现场直取")


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
