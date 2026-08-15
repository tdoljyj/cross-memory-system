#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""附录 B 验收标准自动化测试（无第三方依赖，纯标准库 + 轻量 runner）。

覆盖《架构基线文档-vNext.md》vNext-1.2「第十八节 验收标准 / 附录 B」中可在代码层验证的
机制级不变量：

  D 有变化 → 提交 + 推送 + git log 出现新 commit
  E 无变化 → 不写、不推（NO_CHANGE → NO_SYNC）
  F 并发    → fetch+merge 收敛，先到者变更不丢
  G 幂等    → 相同内容不产生重复提交
  H 同步失败 → 写 .sync-failed、可重试、成功后清除标记
  I 缓存    → pull 后本地与远端一致（版本校验 / 缓存失效）
  B/C       → 段级召回映射与 memory/*.md 真实标题逐字一致

B/C 的 Router 判定（T0–T4）本身是 AI 自然语言行为，无法在脚本层断言；此处只验证其
「段级召回映射正确性」这一可判定不变量。另附一条删除传播护栏（P0）回归测试。

运行：python tests/test_acceptance.py
"""

import functools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PS1 = os.path.join(REPO_ROOT, "sync-memory.ps1")
PY = os.path.join(REPO_ROOT, "sync-memory.py")
AGENTS = os.path.join(REPO_ROOT, "AGENTS.md")
MEMORY = os.path.join(REPO_ROOT, "memory")

GIT = shutil.which("git") or "git"
# 优先 pwsh（PowerShell 7）：本机 Windows PowerShell 5.1 的 PSModulePath 被 pwsh
# 运行时污染，Get-FileHash 不可用；真实同步脚本运行环境即 pwsh。
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")

MEMORY_FILES = ["画像.md", "状态.md", "决策.md", "待办.md", "归档.md"]


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def sh(cmd, cwd=None, check_fail=True, timeout=90):
    p = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=timeout,
    )
    if check_fail and p.returncode != 0:
        raise AssertionError(
            "command failed (%d): %s\nstdout:\n%s\nstderr:\n%s"
            % (p.returncode, " ".join(cmd), p.stdout, p.stderr))
    return p


def git(*args, cwd):
    return sh([GIT, "-C", cwd] + list(args))


class Sandbox:
    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="codex-memory-test-")
        self.remote = os.path.join(self.tmp, "remote.git")
        sh([GIT, "init", "--bare", "-b", "main", self.remote])

    def add_clone(self, name):
        clone = os.path.join(self.tmp, name)
        sh([GIT, "clone", self.remote, clone])
        branch = sh([GIT, "-C", clone, "symbolic-ref", "--short", "-q", "HEAD"],
                    check_fail=False).stdout.strip()
        if not branch:
            sh([GIT, "-C", clone, "checkout", "-b", "main"])
        elif branch != "main":
            sh([GIT, "-C", clone, "branch", "-m", "main"])
        git("config", "user.name", "Test", cwd=clone)
        git("config", "user.email", "test@example.com", cwd=clone)
        # 仅在空克隆（首个克隆）时写入初始提交；后续克隆已含远端 init 提交
        p = sh([GIT, "-C", clone, "rev-parse", "--verify", "HEAD"], check_fail=False)
        if p.returncode != 0:
            memdir = os.path.join(clone, "memory")
            os.makedirs(memdir, exist_ok=True)
            for f in MEMORY_FILES:
                with open(os.path.join(memdir, f), "w", encoding="utf-8") as fh:
                    fh.write("# %s\n\n内容 %s\n" % (f, f))
            git("add", "-A", cwd=clone)
            git("commit", "-m", "init", cwd=clone)
            git("push", "-u", "origin", "main", cwd=clone)
        return clone

    def install_py(self, clone):
        # 工具目录放在克隆之外，避免被测试里的 `git add -A` 一并提交，
        # 否则会在并发/拉取用例中制造无关的 add/add 冲突。
        d = os.path.join(self.tmp, "tool-" + os.path.basename(clone))
        os.makedirs(d, exist_ok=True)
        script = os.path.join(d, "sync-memory.py")
        shutil.copy(PY, script)
        with open(os.path.join(d, "sync.config.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({
                "repo": clone,
                "proxy": "",
                "proxy_host": "127.0.0.1",
                "proxy_port": 7897,
            }, fh)
        return script

    def run_py(self, script, mode):
        return sh([sys.executable, script, mode],
                  cwd=os.path.dirname(script), check_fail=False)

    def install_ps1(self, clone, workdir):
        shutil.copy(PS1, os.path.join(clone, "sync-memory.ps1"))
        os.makedirs(workdir, exist_ok=True)
        for f in MEMORY_FILES:
            shutil.copy(os.path.join(clone, "memory", f),
                        os.path.join(workdir, f))
        cfg = (
            '$AgentName = "Test"\n'
            '$HostName = "TESTBOX"\n'
            '$ProxyUrl = ""\n'
            "$MemoryDir = '%s'\n"
            '$GitEmail = "test@example.com"\n'
        ) % workdir
        with open(os.path.join(clone, "sync.config.ps1"), "w",
                  encoding="utf-8") as fh:
            fh.write(cfg)
        return os.path.join(clone, "sync-memory.ps1")

    def run_ps1(self, clone, *args):
        script = os.path.join(clone, "sync-memory.ps1")
        return sh([POWERSHELL, "-ExecutionPolicy", "Bypass", "-File", script]
                  + list(args), cwd=clone, check_fail=False)

    def remote_head(self):
        return sh([GIT, "ls-remote", self.remote, "main"]).stdout.split()[0]

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


RECALL_RE = re.compile(r'([\u4e00-\u9fffA-Za-z0-9_]+\.md)((?:「[^」]+」)+)')


def recall_pairs(text):
    for m in RECALL_RE.finditer(text):
        fname = m.group(1)
        for sec in re.findall(r'「([^」]+)」', m.group(2)):
            yield fname, sec


def sandboxed(fn):
    @functools.wraps(fn)
    def wrapper():
        sb = Sandbox()
        try:
            fn(sb)
        finally:
            sb.cleanup()
    return wrapper


@sandboxed
def test_recall_mapping_matches_memory_sections(sb):
    pairs = list(recall_pairs(open(AGENTS, encoding="utf-8").read()))
    check(pairs, "未从 AGENTS.md 解析到段级召回映射")
    for fname, section in pairs:
        fp = os.path.join(MEMORY, fname)
        check(os.path.isfile(fp), "映射引用不存在的文件: %s" % fname)
        content = open(fp, encoding="utf-8").read()
        check("## " + section in content,
              "映射引用不存在的标题段: %s「%s」" % (fname, section))
    check(len(pairs) >= 5, "召回映射条目过少，疑似解析错误")


@sandboxed
def test_ps1_no_change_skips_commit(sb):
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    p = sb.run_ps1(clone)
    check(p.returncode == 0, p.stdout + p.stderr)
    check("No memory changes" in p.stdout, p.stdout)
    check(sb.remote_head() == before, "无变化时不应产生新推送")


@sandboxed
def test_ps1_change_commits_and_pushes(sb):
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n新增事实：用户喜欢鱼火\n")
    p = sb.run_ps1(clone)
    check(p.returncode == 0, p.stdout + p.stderr)
    check("Memory synced" in p.stdout, p.stdout)
    check(sb.remote_head() != before, "有变化时应产生新推送")
    check("memory sync" in git("log", "--oneline", "-3", cwd=clone).stdout,
          "git log 应出现 memory sync 提交")


@sandboxed
def test_py_push_is_idempotent(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    with open(os.path.join(clone, "memory", "决策.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\n新决策\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "change", cwd=clone)
    check(sb.run_py(script, "push").returncode == 0, "首次 push 应成功")
    head1 = sb.remote_head()
    p2 = sb.run_py(script, "push")
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    check(sb.remote_head() == head1, "重复 push 不应产生新提交")


@sandboxed
def test_py_concurrent_merge_no_loss(sb):
    a = sb.add_clone("a")
    b = sb.add_clone("b")
    sa = sb.install_py(a)
    sb_script = sb.install_py(b)
    with open(os.path.join(a, "memory", "画像.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\nA 的修改\n")
    git("add", "-A", cwd=a)
    git("commit", "-m", "A", cwd=a)
    check(sb.run_py(sa, "push").returncode == 0, "A push 应成功")
    with open(os.path.join(b, "memory", "决策.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\nB 的修改\n")
    git("add", "-A", cwd=b)
    git("commit", "-m", "B", cwd=b)
    p = sb.run_py(sb_script, "push")
    check(p.returncode == 0, p.stdout + p.stderr)
    check_clone = os.path.join(sb.tmp, "check")
    sh([GIT, "clone", sb.remote, check_clone])
    check("A 的修改" in open(os.path.join(check_clone, "memory", "画像.md"),
                             encoding="utf-8").read(), "A 的修改丢失")
    check("B 的修改" in open(os.path.join(check_clone, "memory", "决策.md"),
                             encoding="utf-8").read(), "B 的修改丢失")


@sandboxed
def test_py_sync_failure_writes_marker_and_retries(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    with open(os.path.join(clone, "memory", "待办.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\n待办\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "x", cwd=clone)
    git("remote", "set-url", "origin",
        os.path.join(sb.tmp, "gone.git"), cwd=clone)
    p1 = sb.run_py(script, "push")
    check(p1.returncode != 0, "远端不可达时 push 应失败")
    marker = os.path.join(clone, ".sync-failed")
    check(os.path.isfile(marker), "同步失败应写 .sync-failed")
    git("remote", "set-url", "origin", sb.remote, cwd=clone)
    p2 = sb.run_py(script, "push")
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    check(not os.path.exists(marker), "重试成功后应清除 .sync-failed")


@sandboxed
def test_py_pull_aligns_to_remote(sb):
    a = sb.add_clone("a")
    b = sb.add_clone("b")
    sa = sb.install_py(a)
    sb_script = sb.install_py(b)
    with open(os.path.join(a, "memory", "状态.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\n状态 v2\n")
    git("add", "-A", cwd=a)
    git("commit", "-m", "v2", cwd=a)
    check(sb.run_py(sa, "push").returncode == 0, "A push 应成功")
    p = sb.run_py(sb_script, "pull")
    check(p.returncode == 0, p.stdout + p.stderr)
    local = git("rev-parse", "HEAD", cwd=b).stdout.strip()
    check(local == sb.remote_head(),
          "pull 后本地应与远端一致（旧缓存不应继续生效）")


@sandboxed
def test_py_delete_propagation_guard(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    for f in MEMORY_FILES[1:]:
        os.remove(os.path.join(clone, "memory", f))
    git("add", "-A", cwd=clone)
    git("commit", "-m", "wipe", cwd=clone)
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "memory 目录 <5 文件时 push 应被拒绝")
    check("memory 目录不足" in p.stdout, p.stdout)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")


TESTS = [
    test_recall_mapping_matches_memory_sections,
    test_ps1_no_change_skips_commit,
    test_ps1_change_commits_and_pushes,
    test_py_push_is_idempotent,
    test_py_concurrent_merge_no_loss,
    test_py_sync_failure_writes_marker_and_retries,
    test_py_pull_aligns_to_remote,
    test_py_delete_propagation_guard,
]


def main():
    failures = 0
    for fn in TESTS:
        name = fn.__name__
        if "ps1" in name and not POWERSHELL:
            print("SKIP %s (PowerShell 不可用)" % name)
            continue
        try:
            fn()
            print("PASS %s" % name)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (name, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
