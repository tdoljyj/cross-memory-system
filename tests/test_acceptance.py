#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""附录 B 验收标准自动化测试（无第三方依赖，纯标准库 + 轻量 runner）。

覆盖《架构基线文档-vNext-1.3.md》vNext-1.3「第十八节 验收标准 / 附录 B」中可在代码层验证的
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
            shutil.copy(os.path.join(MEMORY, "index.json"),
                        os.path.join(memdir, "index.json"))
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

    def run_py(self, script, mode, *extra):
        return sh([sys.executable, script, mode] + list(extra),
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


def sandboxed(fn):
    @functools.wraps(fn)
    def wrapper():
        sb = Sandbox()
        try:
            fn(sb)
        finally:
            sb.cleanup()
    return wrapper


def test_index_json_recall_mapping_valid():
    idx_path = os.path.join(MEMORY, "index.json")
    check(os.path.isfile(idx_path), "memory/index.json 缺失")
    idx = json.load(open(idx_path, encoding="utf-8"))
    check(idx.get("schema_version") == 1, "index.json schema_version 应为 1")

    files = idx.get("files")
    check(isinstance(files, list) and len(files) >= 5, "index.json files 清单缺失或过短")
    for f in files:
        fp = os.path.join(MEMORY, f)
        check(os.path.isfile(fp) and os.path.getsize(fp) > 0,
              "files 引用了不存在或为空的文件: %s" % f)

    recall = idx.get("recall")
    check(isinstance(recall, dict), "index.json recall 缺失")
    for key in ("L1", "L2", "L3", "L4", "L5", "L6"):
        check(key in recall, "recall 缺少类型 %s" % key)
    for key, entries in recall.items():
        for entry in entries:
            f = entry.get("file")
            check(f in files, "%s 引用了未知文件 %s" % (key, f))
            content = open(os.path.join(MEMORY, f), encoding="utf-8").read()
            for sec in entry.get("sections", []):
                check("## " + sec in content,
                      "%s 引用了不存在的标题段 %s「%s」" % (key, f, sec))

    # 协议文档应把 index.json 声明为召回权威源，避免退回散文唯一来源。
    check("memory/index.json" in open(AGENTS, encoding="utf-8").read(),
          "AGENTS.md 未引用 memory/index.json 作为权威召回源")


def test_redact_masks_tokens():
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check(mod.redact("gho_ABC123xyz") == "gho_***", "gho_ 令牌未掩码")
    check("ghp_***" in mod.redact("x ghp_123 y"), "ghp_ 令牌未掩码")
    check(mod.redact("github_pat_abc_1") == "github_pat_***",
          "github_pat_ 令牌未掩码")
    out = mod.redact("Authorization: Bearer abc123")
    check("Bearer abc123" not in out and "***" in out, "Bearer 令牌未掩码")


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
    check(p.returncode != 0, "memory 目录缺少必需文件时 push 应被拒绝")
    check("必需文件" in p.stdout, p.stdout)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")


@sandboxed
def test_py_missing_index_guard(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    os.remove(os.path.join(clone, "memory", "index.json"))
    git("add", "-A", cwd=clone)
    git("commit", "-m", "drop index", cwd=clone)
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "缺少 memory/index.json 时 push 应被拒绝")
    check("index.json" in p.stdout, p.stdout)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")


@sandboxed
def test_py_secret_scan_blocks_push(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    before = sb.remote_head()
    with open(os.path.join(clone, "memory", "决策.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\nghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "leak", cwd=clone)
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "密钥样值应被拒绝")
    check("secret" in (p.stdout + p.stderr), p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "密钥扫描触发时应写 .sync-failed")
    check(sb.remote_head() == before, "密钥样值不应推上远端")


@sandboxed
def test_py_access_none_skips_pull(sb):
    a = sb.add_clone("a")
    b = sb.add_clone("b")
    sa = sb.install_py(a)
    sb_script = sb.install_py(b)
    with open(os.path.join(a, "memory", "状态.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\n状态 v3\n")
    git("add", "-A", cwd=a)
    git("commit", "-m", "v3", cwd=a)
    check(sb.run_py(sa, "push").returncode == 0, "A push 应成功")
    p = sb.run_py(sb_script, "pull", "NONE")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("NONE" in p.stdout, p.stdout)
    local = git("rev-parse", "HEAD", cwd=b).stdout.strip()
    check(local != sb.remote_head(), "Access=NONE 时不应拉取远端")


@sandboxed
def test_py_lock_blocks_concurrent(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    lock = os.path.join(clone, ".sync.lock")
    with open(lock, "w", encoding="ascii") as fh:
        fh.write(str(os.getpid()))
    try:
        p = sb.run_py(script, "push")
        check(p.returncode != 0, "已有持锁进程时应拒绝 push")
        check("锁" in (p.stdout + p.stderr) or "lock" in (p.stdout + p.stderr),
              p.stdout + p.stderr)
        check(os.path.isfile(os.path.join(clone, ".sync-failed")),
              "持锁拒绝时应写 .sync-failed")
    finally:
        if os.path.exists(lock):
            os.remove(lock)


@sandboxed
def test_py_dangling_ref_rejected(sb):
    """R2 回归：restore_tracking_ref 不得写出悬空 ref（对象不在本地时拒绝）。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_r2", script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    dead = "deadbeef" + "0" * 32  # 40 位 hex，对象必然不存在
    ok = mod.restore_tracking_ref(dead)
    check(ok is False, "悬空对象不应写入 tracking ref")
    ref_path = os.path.join(clone, ".git", "refs", "remotes", "origin", "main")
    check(not os.path.isfile(ref_path), "不应生成悬空 tracking ref 文件")


@sandboxed
def test_py_pull_ahead_self_heals(sb):
    """R4 回归：本地领先远端（上次 push 失败遗留）时，pull 应补推而非判分叉卡死。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    before = sb.remote_head()
    with open(os.path.join(clone, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n领先的本地提交\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "local ahead", cwd=clone)
    check(git("rev-parse", "HEAD", cwd=clone).stdout.strip() != before,
          "本地应领先远端")
    p = sb.run_py(script, "pull")
    check(p.returncode == 0, p.stdout + p.stderr)
    check(sb.remote_head() == git("rev-parse", "HEAD", cwd=clone).stdout.strip(),
          "pull 自愈后本地应与远端一致")


@sandboxed
def test_ps1_pull_fails_closed_on_bad_remote(sb):
    """R1 回归：远端不可达时 -Pull 必须失败退出，不得假报 already up to date。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    git("remote", "set-url", "origin", os.path.join(sb.tmp, "gone.git"), cwd=clone)
    p = sb.run_ps1(clone, "-Pull")
    check(p.returncode != 0, "-Pull 远端不可达时必须失败退出（fail-closed）")
    check("already up to date" not in p.stdout, "不得假报 already up to date")


@sandboxed
def test_ps1_deploy_guard_blocks_workbuddy_path(sb):
    """R3 回归：脚本在 .workbuddy 路径内执行必须被拒绝（部署位置护栏）。"""
    wbdir = os.path.join(sb.tmp, ".workbuddy", "codex-memory-system")
    os.makedirs(wbdir, exist_ok=True)
    script = os.path.join(wbdir, "sync-memory.ps1")
    shutil.copy(PS1, script)
    p = sh([POWERSHELL, "-ExecutionPolicy", "Bypass", "-File", script, "-Doctor"],
           cwd=wbdir, check_fail=False)
    check(p.returncode != 0, "在 .workbuddy 路径执行必须被拒绝")
    check("[deploy-guard]" in p.stdout, "应输出部署位置护栏标记")


@sandboxed
def test_ps1_secret_scan_blocks(sb):
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\nghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n")
    p = sb.run_ps1(clone)
    check(p.returncode != 0, p.stdout + p.stderr)
    check("secret" in (p.stdout + p.stderr), p.stdout + p.stderr)
    check(sb.remote_head() == before, "密钥样值不应推上远端")


@sandboxed
def test_ps1_commit_repo_commits_docs(sb):
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    with open(os.path.join(clone, "NEW_DOC.md"), "w", encoding="utf-8") as fh:
        fh.write("# 新增文档\n")
    p = sb.run_ps1(clone, "-CommitRepo")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("Repo synced" in p.stdout, p.stdout)
    check(sb.remote_head() != before, "-CommitRepo 应产生新提交并推送")
    check("repo sync" in git("log", "--oneline", "-3", cwd=clone).stdout,
          "git log 应出现 repo sync 提交")


TESTS = [
    test_index_json_recall_mapping_valid,
    test_redact_masks_tokens,
    test_ps1_no_change_skips_commit,
    test_ps1_change_commits_and_pushes,
    test_ps1_secret_scan_blocks,
    test_ps1_commit_repo_commits_docs,
    test_py_push_is_idempotent,
    test_py_concurrent_merge_no_loss,
    test_py_sync_failure_writes_marker_and_retries,
    test_py_pull_aligns_to_remote,
    test_py_delete_propagation_guard,
    test_py_missing_index_guard,
    test_py_secret_scan_blocks_push,
    test_py_access_none_skips_pull,
    test_py_lock_blocks_concurrent,
    test_py_dangling_ref_rejected,
    test_py_pull_ahead_self_heals,
    test_ps1_pull_fails_closed_on_bad_remote,
    test_ps1_deploy_guard_blocks_workbuddy_path,
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
