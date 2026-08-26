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
import re
import shutil
import subprocess
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PS1 = os.path.join(REPO_ROOT, "sync-memory.ps1")
PY = os.path.join(REPO_ROOT, "sync-memory.py")
AGENTS = os.path.join(REPO_ROOT, "AGENTS.md")
MEMORY = os.path.join(REPO_ROOT, "memory")

# R3 P0-3：ENV 归因（沙盒 overlay 拦截 .git/refs 写入 → doctor probe 必败）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clued_testkit import EnvSkip, env_refs_write_persists  # noqa: E402

GIT = shutil.which("git") or "git"
# 优先 pwsh（PowerShell 7）：本机 Windows PowerShell 5.1 的 PSModulePath 被 pwsh
# 运行时污染，Get-FileHash 不可用；真实同步脚本运行环境即 pwsh。
POWERSHELL = shutil.which("pwsh") or shutil.which("powershell")

MEMORY_FILES = ["画像.md", "状态.md", "决策.md", "待办.md", "归档.md"]

# Sprint 2：协议行为契约（唯一契约源：conformance 测试读它，不硬编码期望）
MANIFEST_PATH = os.path.join(REPO_ROOT, "protocol-manifest.json")


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


def _ps1_git_unsafe():
    """ps1 用例环境预检（措施5/7）：ps1 的 Test-GitClientSafe 用 PowerShell 解析到的
    git 路径判断（含 PortableGit/.workbuddy 即拦截）。环境不满足时 ps1 用例应 SKIP
    而非 FAIL，使「红 = 真回归」成立，消除 PATH 顺序（PortableGit 排前）导致的噪声红。"""
    p = sh([POWERSHELL, "-NoProfile", "-Command",
            "(Get-Command git -ErrorAction SilentlyContinue).Source"],
           check_fail=False)
    g = (p.stdout or "").strip()
    return bool(g) and ("PortableGit" in g or ".workbuddy" in g)


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
                # 复制真实记忆文件（含真实标题段），使 doctor 的 index 召回段名校验可过
                shutil.copy(os.path.join(MEMORY, f), os.path.join(memdir, f))
            shutil.copy(os.path.join(MEMORY, "index.json"),
                        os.path.join(memdir, "index.json"))
            # 复刻仓库根文件，使 ps1 doctor 的全局钩子一致性检查有可比对象
            shutil.copy(os.path.join(REPO_ROOT, "AGENTS.md"),
                        os.path.join(clone, "AGENTS.md"))
            shutil.copy(os.path.join(REPO_ROOT, "guards.json"),
                        os.path.join(clone, "guards.json"))
            shutil.copy(os.path.join(REPO_ROOT, ".gitattributes"),
                        os.path.join(clone, ".gitattributes"))
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
        # bootstrap 等价配置：doctor 的 autocrlf / union driver 检查需要
        git("config", "core.autocrlf", "false", cwd=clone)
        git("config", "merge.union.driver", "git merge-file --union %A %O %B", cwd=clone)
        git("config", "maintenance.auto", "false", cwd=clone)
        git("config", "gc.pruneExpire", "2.weeks", cwd=clone)
        git("config", "fetch.autoMaintenance", "false", cwd=clone)
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
    # 文件集下限不再硬编码数量（vNext-1.3：index.json 是唯一事实源，护栏读 files 清单）；
    # 仅要求清单非空且逐项存在非空（删除传播护栏口径与实现一致，P1-2）。
    check(isinstance(files, list) and len(files) >= 1, "index.json files 清单为空")
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


def test_redact_covers_all_guards_patterns():
    # 脱敏必须覆盖 guards.json 全部 secret_patterns（防扫描拒绝但日志未掩码的契约裂口）
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_redact_all", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    with open(os.path.join(REPO_ROOT, "guards.json"), encoding="utf-8") as fh:
        guards = json.load(fh)
    check(len(guards["secret_patterns"]) == 5, "guards.json secret_patterns 应为 5 条")
    cases = {
        "ghp_" + "A" * 24: "ghp_***",
        "gho_" + "A" * 24: "gho_***",
        "github_pat_" + "a" * 24: "github_pat_***",
        "AKIA" + "A" * 16: "AKIA***",
        # 样例运行时拼接，避免文件内出现可被扫描模式命中的字面样值（自命中误报）
        "-----BEGIN " + "RSA PRIVATE KEY-----": "-----BEGIN PRIVATE KEY HEADER-----",
        "Bearer " + "a" * 24: "Bearer ***",
    }
    for sample, expected in cases.items():
        out = mod.redact(sample)
        check(out == expected,
              "redact(%r...) = %r，期望 %r（guards.json 模式脱敏覆盖不完整）"
              % (sample[:24], out, expected))


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
    check("index.json 缺失或非法" in p.stdout,
          "index 缺失应报独立口径（缺失/非法），而非「缺少必需文件」: " + p.stdout)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")


@sandboxed
def test_py_index_path_traversal_rejected(sb):
    """GAP-3-10 回归：index.json files 含 ../ 越界项时按索引非法 fail-closed 拒绝 push。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    idx_path = os.path.join(clone, "memory", "index.json")
    with open(idx_path, "r", encoding="utf-8") as fh:
        idx = json.load(fh)
    idx["files"] = list(idx["files"]) + ["../evil.md"]
    with open(idx_path, "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False, indent=2)
    git("add", "-A", cwd=clone)
    git("commit", "-m", "path traversal index", cwd=clone)
    before = sb.remote_head()
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "越界 files 项应被拒绝: " + p.stdout + p.stderr)
    check(sb.remote_head() == before, "远端不得变化")


@sandboxed
def test_ps1_index_path_traversal_rejected(sb):
    """GAP-3-10 回归：index.json files 含 ../ 越界项时 ps1 按索引非法 fail-closed 拒绝。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    idx_path = os.path.join(clone, "memory", "index.json")
    with open(idx_path, "r", encoding="utf-8") as fh:
        idx = json.load(fh)
    idx["files"] = list(idx["files"]) + ["../evil.md"]
    with open(idx_path, "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False, indent=2)
    git("add", "-A", cwd=clone)
    git("commit", "-m", "path traversal index", cwd=clone)
    before = sb.remote_head()
    p = sb.run_ps1(clone)
    check(p.returncode != 0, "越界 files 项应被拒绝: " + p.stdout + p.stderr)
    check(sb.remote_head() == before, "远端不得变化")


@sandboxed
def test_py_secret_scan_blocks_push(sb):
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    before = sb.remote_head()
    with open(os.path.join(clone, "memory", "决策.md"), "a",
              encoding="utf-8") as fh:
        fh.write("\n" + "ghp_" + "A" * 32 + "\n")  # 运行时拼接，防测试文件自命中扫描模式
    git("add", "-A", cwd=clone)
    git("commit", "-m", "leak", cwd=clone)
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "密钥样值应被拒绝")
    check("secret" in (p.stdout + p.stderr), p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "密钥扫描触发时应写 .sync-failed")
    check(sb.remote_head() == before, "密钥样值不应推上远端")


@sandboxed
def test_py_push_refuses_staged_secret_index_blob(sb):
    """P2-1 回归：staged 非 memory 文件含令牌、工作树已回改为干净内容时，staged 扫描
    必须读 index blob 并拒绝 push（工作树读取会被 TOCTOU 绕过）。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    tok = "ghp_" + "A" * 32
    extra = os.path.join(clone, "README_secret.md")
    with open(extra, "w", encoding="utf-8") as fh:
        fh.write("doc\n" + tok + "\n")
    git("add", "README_secret.md", cwd=clone)
    with open(extra, "w", encoding="utf-8") as fh:
        fh.write("doc clean\n")
    with open(os.path.join(clone, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n触发 push\n")
    git("commit", "-m", "mem", "--", "memory", cwd=clone)
    before = sb.remote_head()
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "staged 令牌应被拒绝: " + p.stdout + p.stderr)
    check("secret" in (p.stdout + p.stderr), p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")
    check(sb.remote_head() == before, "远端不得变化")


@sandboxed
def test_py_push_refuses_committed_non_memory_secret(sb):
    """P2-2 回归：令牌已 commit 进非 memory 文件（脚本/文档）且 staged 为空时，
    push 必须扫 origin..HEAD 并拒绝（消除「已提交令牌直接 push」的防护空洞）。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    tok = "ghp_" + "A" * 32
    with open(os.path.join(clone, "README_token.md"), "w", encoding="utf-8") as fh:
        fh.write("doc\n" + tok + "\n")
    git("add", "README_token.md", cwd=clone)
    git("commit", "-m", "non-memory token", cwd=clone)
    before = sb.remote_head()
    p = sb.run_py(script, "push")
    check(p.returncode != 0, "已提交令牌应被拒绝: " + p.stdout + p.stderr)
    check("secret" in (p.stdout + p.stderr), p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")
    check(sb.remote_head() == before, "远端不得变化")


@sandboxed
def test_py_push_allows_clean_non_memory_commit(sb):
    """P2-2 配套：干净的 non-memory 提交不被误拒，正常推送。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    with open(os.path.join(clone, "README_clean.md"), "w", encoding="utf-8") as fh:
        fh.write("# 干净文档\n")
    git("add", "README_clean.md", cwd=clone)
    git("commit", "-m", "clean doc", cwd=clone)
    p = sb.run_py(script, "push")
    check(p.returncode == 0, p.stdout + p.stderr)
    checkclone = os.path.join(sb.tmp, "check-clean")
    sh([GIT, "clone", sb.remote, checkclone])
    check(os.path.isfile(os.path.join(checkclone, "README_clean.md")),
          "干净非 memory 提交应正常推送")


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
    # 注意：add_clone 的 `push -u` 已生成 loose tracking ref 文件，断言必须比对内容
    # 是否被改写，而非「文件不应存在」（原断言在 loose ref 环境下假红）。
    ref_path = os.path.join(clone, ".git", "refs", "remotes", "origin", "main")
    before = None
    if os.path.isfile(ref_path):
        with open(ref_path, "r", encoding="ascii") as fh:
            before = fh.read().strip()
    ok = mod.restore_tracking_ref(dead)
    check(ok is False, "悬空对象不应写入 tracking ref")
    after = None
    if os.path.isfile(ref_path):
        with open(ref_path, "r", encoding="ascii") as fh:
            after = fh.read().strip()
    check(after == before,
          "悬空对象不应改写既有 tracking ref 文件（原=%s 现=%s）" % (before, after))


@sandboxed
def test_py_repo_defaults_to_script_dir(sb):
    """P0-2 回归：sync.config.json 缺失时 REPO 默认 = 脚本所在克隆（原默认指向
    WorkBuddy 克隆路径，属 fail-open 越界默认）。"""
    clone = sb.add_clone("a")
    script = os.path.join(clone, "sync-memory.py")
    shutil.copy(PY, script)
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_default_repo", script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check(mod.REPO == clone,
          "REPO 默认应为脚本所在克隆 %r，实为 %r" % (clone, mod.REPO))


@sandboxed
def test_py_lock_stale_pid_cleared(sb):
    """P1 回归：陈旧锁（持锁 PID 已退出，但 Windows 进程对象可能尚存）必须能被清理，
    不得永久楔住同步。os.kill(pid,0) 语义跨构建不一致，判活改 OpenProcess+GetExitCodeProcess。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_lock2", script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    dead_pid = child.pid
    lock = os.path.join(clone, ".sync.lock")
    with open(lock, "w", encoding="ascii") as fh:
        fh.write(str(dead_pid))
    try:
        ok = mod.acquire_lock()
        check(ok is True, "陈旧锁（已退出 PID=%s）应被清理并成功加锁" % dead_pid)
    finally:
        if os.path.exists(lock):
            os.remove(lock)


@sandboxed
def test_py_pull_ahead_self_heals(sb):
    """措施8 回归：本地领先远端（上次 push 失败遗留）时，pull=读不在此 push，
    只报告并写 .needs-push 标记；远端保持不变，由使用方非沙盒显式 push。"""
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
    check(sb.remote_head() == before,
          "pull=读不应 push，远端应保持不变")
    check(os.path.exists(os.path.join(clone, ".needs-push")),
          "领先时应写 .needs-push 标记")


@sandboxed
def test_ps1_pull_access_none_pure_shortcircuit(sb):
    """P2-4 回归：-Pull -Access NONE 必须进程级零副作用短路——即使仓库 memory 脏、
    存在过期 TEMP 备份，也不写 .sync-failed、不清理 TEMP、不取锁、不写 git 身份、
    不访问远端、不改动工作树。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    # 制造会触发各 preflight 失败/副作用的状态
    with open(os.path.join(clone, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n未提交脏变更\n")
    stale = os.path.join(tempfile.gettempdir(), "codex-memory-backup-2000-01-01")
    os.makedirs(stale, exist_ok=True)
    os.utime(stale, (time.time() - 400 * 86400, time.time() - 400 * 86400))
    before_head = sb.remote_head()
    p = sb.run_ps1(clone, "-Pull", "-Access", "NONE")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("skipping pull" in p.stdout, p.stdout)
    check(not os.path.isfile(os.path.join(clone, ".sync-failed")),
          "NONE 短路不得写 .sync-failed")
    check(not os.path.exists(os.path.join(clone, ".sync.lock")),
          "NONE 短路不得取锁/留锁文件")
    check(os.path.isdir(stale), "NONE 短路不得清理 TEMP 备份目录")
    check(git("config", "user.name", cwd=clone).stdout.strip() == "Test",
          "NONE 短路不得执行 git config 身份写入")
    check(sb.remote_head() == before_head, "NONE 短路不得访问/修改远端")
    dirty = sh([GIT, "-C", clone, "-c", "core.quotepath=false",
                "status", "--porcelain", "--", "memory"]).stdout
    check("状态.md" in dirty, "NONE 短路不得改动/合并工作树")
    shutil.rmtree(stale, ignore_errors=True)


@sandboxed
def test_ps1_push_refuses_committed_non_memory_secret(sb):
    """Sprint2（P2-2 对齐 py）回归：令牌已 commit 进非 memory 文件（staged 为空）时，
    ps1 memory sync push 必须扫 origin/main..HEAD 并拒绝，不得把令牌带上远端。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    tok = "ghp_" + "A" * 32
    with open(os.path.join(clone, "README_token.md"), "w", encoding="utf-8") as fh:
        fh.write("doc\n" + tok + "\n")
    git("add", "README_token.md", cwd=clone)
    git("commit", "-m", "non-memory token", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n工作区记忆改动\n")
    p = sb.run_ps1(clone)
    check(p.returncode != 0, "已提交令牌应被拒绝: " + p.stdout + p.stderr)
    check("secret" in (p.stdout + p.stderr).lower(), p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")
    check(sb.remote_head() == before, "令牌样值不得推上远端")


@sandboxed
def test_ps1_push_allows_clean_non_memory_commit(sb):
    """Sprint2 配套：干净的已提交非 memory 文件不被误拒，随 memory sync 正常推送。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    with open(os.path.join(clone, "README_clean.md"), "w", encoding="utf-8") as fh:
        fh.write("# 干净文档\n")
    git("add", "README_clean.md", cwd=clone)
    git("commit", "-m", "clean doc", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n工作区记忆改动\n")
    p = sb.run_ps1(clone)
    check(p.returncode == 0, p.stdout + p.stderr)
    checkclone = os.path.join(sb.tmp, "check-clean")
    sh([GIT, "clone", sb.remote, checkclone])
    check(os.path.isfile(os.path.join(checkclone, "README_clean.md")),
          "干净非 memory 已提交文件应正常推送")


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
    check("Unsafe git client" not in (p.stdout + p.stderr),
          "失败应源于远端不可达，而非 git 客户端护栏拦截（防假通过）")


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
    # GAP-3-8 回归：护栏拒绝路径不得出现「Set-SyncFailed 未定义」的 trap 噪音
    check("Set-SyncFailed" not in (p.stdout + p.stderr),
          "deploy-guard 拒绝不得产生 trap 噪音: " + (p.stdout + p.stderr)[:300])


@sandboxed
def test_ps1_deploy_guard_blocks_dsh_path(sb):
    """P0-3 回归：ps1 在 .dsh 克隆路径内执行必须被拒绝（第三端接入后补的覆盖单元格）。"""
    dshdir = os.path.join(sb.tmp, ".dsh", "projects", "cross-memory-system")
    os.makedirs(dshdir, exist_ok=True)
    script = os.path.join(dshdir, "sync-memory.ps1")
    shutil.copy(PS1, script)
    p = sh([POWERSHELL, "-ExecutionPolicy", "Bypass", "-File", script, "-Doctor"],
           cwd=dshdir, check_fail=False)
    check(p.returncode != 0, "在 .dsh 路径执行必须被拒绝")
    check("[deploy-guard]" in p.stdout, "应输出部署位置护栏标记")


@sandboxed
def test_ps1_secret_scan_blocks(sb):
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n" + "ghp_" + "A" * 32 + "\n")  # 运行时拼接，防测试文件自命中扫描模式
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


@sandboxed
def test_ps1_push_scopes_to_index_files(sb):
    """P2 回归：push 只处理 index.json 声明的必需文件——工作区额外 .md 不得入库，
    仓库既有非 index .md 不得被删除。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    extra = os.path.join(workdir, "私密笔记.md")
    with open(extra, "w", encoding="utf-8") as fh:
        fh.write("用户私有，不应进入仓库\n")
    with open(os.path.join(clone, "memory", "备注.md"), "w", encoding="utf-8") as fh:
        fh.write("仓库既有备注（非 index）\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "add non-index", cwd=clone)
    git("push", "-u", "origin", "main", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n推送触发\n")
    p = sb.run_ps1(clone)
    check(p.returncode == 0, p.stdout + p.stderr)
    check("Memory synced" in p.stdout, p.stdout)
    checkclone = os.path.join(sb.tmp, "check-scope")
    sh([GIT, "clone", sb.remote, checkclone])
    memdir = os.path.join(checkclone, "memory")
    check(not os.path.isfile(os.path.join(memdir, "私密笔记.md")),
          "工作区非 index 文件不应入库")
    check(os.path.isfile(os.path.join(memdir, "备注.md")),
          "仓库既有非 index 文件不应被删除")
    check(not os.path.isfile(os.path.join(clone, "memory", "私密笔记.md")),
          "push 不应复制非 index 文件到仓库")


@sandboxed
def test_ps1_push_prestaged_non_memory_not_committed(sb):
    """P0-1 回归：预 staged 非 memory 文件不得被 memory sync 提交卷入（paths 收窄）。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    with open(os.path.join(clone, "AGENTS.md"), "w", encoding="utf-8") as fh:
        fh.write("# tampered\n预 stage 非 memory 文件\n")
    git("add", "AGENTS.md", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n推送触发\n")
    p = sb.run_ps1(clone)
    check(p.returncode == 0, p.stdout + p.stderr)
    check("Memory synced" in p.stdout, p.stdout)
    checkclone = os.path.join(sb.tmp, "check")
    sh([GIT, "clone", sb.remote, checkclone])
    remote_agents = open(os.path.join(checkclone, "AGENTS.md"), encoding="utf-8").read()
    check("tampered" not in remote_agents, "预 staged 非 memory 文件被卷入提交")
    msg = git("log", "-1", "--format=%s", cwd=clone).stdout.strip()
    check("AGENTS.md" not in msg, "commit message 不应包含非 memory 文件: %s" % msg)
    check("画像.md" in msg, "commit message 应包含 memory 文件: %s" % msg)
    staged = sh([GIT, "-C", clone, "diff", "--cached", "--name-only"]).stdout.split()
    check("AGENTS.md" in staged, "预 staged 文件应保持 staged（不提交也不 reset）")
    check(sb.remote_head() != before, "memory 变更应正常推送")


@sandboxed
def test_ps1_push_no_change_with_prestaged_skips(sb):
    """P0-1 回归：仅预 staged 非 memory 文件、无 memory 变化时不得产生提交推送。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    with open(os.path.join(clone, "README_extra.md"), "w", encoding="utf-8") as fh:
        fh.write("pre-staged only\n")
    git("add", "README_extra.md", cwd=clone)
    p = sb.run_ps1(clone)
    check(p.returncode == 0, p.stdout + p.stderr)
    check("No memory changes" in p.stdout, p.stdout)
    check(sb.remote_head() == before, "无 memory 变化时不应推送")
    staged = sh([GIT, "-C", clone, "diff", "--cached", "--name-only"]).stdout.split()
    check("README_extra.md" in staged, "用户预 staged 状态应保留")


@sandboxed
def test_ps1_push_refuses_staged_secret_non_memory(sb):
    """P0-1 回归（blob 读取）：预 staged 非 memory 文件含令牌且工作树已回改时，
    staged 扫描必须读到 index blob 并拒绝推送（工作树读取会被 TOCTOU 绕过）。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before = sb.remote_head()
    tok = "ghp_" + "A" * 32
    extra = os.path.join(clone, "README_secret.md")
    with open(extra, "w", encoding="utf-8") as fh:
        fh.write("doc\n" + tok + "\n")
    git("add", "README_secret.md", cwd=clone)
    with open(extra, "w", encoding="utf-8") as fh:
        fh.write("doc clean\n")
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n工作区记忆改动\n")
    p = sb.run_ps1(clone)
    check(p.returncode != 0, "staged 令牌应被拒绝: " + p.stdout + p.stderr)
    check("secret" in (p.stdout + p.stderr), p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(clone, ".sync-failed")),
          "护栏触发时应写 .sync-failed")
    check(sb.remote_head() == before, "令牌样值不得推上远端")


@sandboxed
def test_ps1_pull_pending_writeback_keeps_extras_and_backup(sb):
    """P1/P2 回归：pending writeback 回写成功路径——非 index 工作区文件不得被删除，
    写回备份必须保留（供恢复），pending 标记清除。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    with open(os.path.join(clone, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n远端更新\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "remote update", cwd=clone)
    git("push", "-u", "origin", "main", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n本地未同步\n")
    with open(os.path.join(workdir, "私有.md"), "w", encoding="utf-8") as fh:
        fh.write("用户私有\n")
    with open(os.path.join(clone, ".pending-writeback"), "w", encoding="utf-8") as fh:
        fh.write("Created: 2026-08-16 00:00:00\n状态.md\n")
    p = sb.run_ps1(clone, "-Pull")
    check(p.returncode == 0, p.stdout + p.stderr)
    check(os.path.isfile(os.path.join(workdir, "私有.md")),
          "非 index 工作区文件不应被删除")
    check(not os.path.exists(os.path.join(clone, ".pending-writeback")),
          "pending 标记应清除")
    snaps = os.path.join(clone, ".conflict-snapshots")
    backups = []
    if os.path.isdir(snaps):
        backups = [d for d in os.listdir(snaps)
                   if d.startswith("codex-memory-writeback-")]
    check(len(backups) >= 1, "成功回写后备份应保留（供恢复）")
    if backups:
        bdir = os.path.join(snaps, backups[0])
        btext = ""
        if os.path.isfile(os.path.join(bdir, "画像.md")):
            with open(os.path.join(bdir, "画像.md"), encoding="utf-8") as fh:
                btext = fh.read()
        check("本地未同步" in btext,
              "备份应含被覆盖前的工作区内容（可恢复）")


def test_py_fetch_error_output_redacted():
    """P0-4 回归：fetch 失败路径的错误文本必须过 redact（防凭据样值落日志）。"""
    import contextlib
    import importlib.util
    import io
    spec = importlib.util.spec_from_file_location("syncmem_fetch_redact", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    tok = "ghp_" + "A" * 32  # 运行时拼接，防测试文件自命中扫描模式
    def fake_git(*args, **kwargs):
        return (1, "", "fatal: unable to access 'https://" + tok + "@github.com/x': TLS error")
    mod.git = fake_git
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        ok = mod.fetch_and_merge()
    out = buf.getvalue()
    check(ok is False, "fetch 失败应返回 False")
    check("[fetch] FAIL" in out, out)
    check(tok not in out, "fetch 错误输出未经 redact 泄露令牌: %r" % out[:200])
    check("ghp_***" in out, "fetch 错误应输出掩码: %r" % out[:200])


@sandboxed
def test_py_consumer_memory_path_config(sb):
    """P0-5 回归：consumer_memory_path 经 sync.config.json 参数化生效（DSH 端指向
    实际注入对象 ~/.dsh/AGENTS.md 而非 ~/.dsh/MEMORY.md）；仓库 AGENTS.md 端枚举须登记 DSH。"""
    clone = sb.add_clone("a")
    tooldir = os.path.join(sb.tmp, "tool-cmp")
    os.makedirs(tooldir, exist_ok=True)
    script = os.path.join(tooldir, "sync-memory.py")
    shutil.copy(PY, script)
    hook = os.path.join(sb.tmp, "AGENTS-hook.md")
    with open(os.path.join(tooldir, "sync.config.json"), "w", encoding="utf-8") as fh:
        json.dump({"repo": clone, "proxy": "", "consumer_memory_path": hook}, fh)
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_consumer_cfg", script)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check(mod.CONSUMER_MEMORY_PATH == hook,
          "consumer_memory_path 参数化未生效: %r" % mod.CONSUMER_MEMORY_PATH)
    agents = open(AGENTS, encoding="utf-8").read()
    check("~/.dsh/AGENTS.md" in agents, "AGENTS.md 端枚举未登记 DSH 消费端")


@sandboxed
def test_py_retention_fallback_defaults_to_7(sb):
    """GAP-2-1 回归：guards.json 缺失/无保留期字段时，py 回落默认必须为 7 天
    （不得回落为 2 天旧口径）。3 天前备份应保留，8 天前备份应被清理。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_retention_fb", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.load_guards = lambda: {}  # guards.json 缺失/无字段 → 回落默认
    keep = os.path.join(tempfile.gettempdir(), "codex-memory-fbkeep-2000")
    drop = os.path.join(tempfile.gettempdir(), "codex-memory-fbdrop-2000")
    for d, days in ((keep, 3), (drop, 8)):
        os.makedirs(d, exist_ok=True)
        os.utime(d, (time.time() - days * 86400, time.time() - days * 86400))
    try:
        mod.cleanup_stale_backups()
        check(os.path.isdir(keep), "3 天前备份在 7 天保留期下应保留")
        check(not os.path.isdir(drop), "8 天前备份应被清理")
    finally:
        shutil.rmtree(keep, ignore_errors=True)
        shutil.rmtree(drop, ignore_errors=True)


@sandboxed
def test_ps1_retention_fallback_defaults_to_7(sb):
    """GAP-2-1 回归：guards.json 缺失时 ps1 回落默认必须为 7 天（-Pull 的 TEMP 清理
    不删除 3 天前备份，删除 8 天前备份）。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    os.remove(os.path.join(clone, "guards.json"))  # 强制回落默认
    keep = os.path.join(tempfile.gettempdir(), "codex-memory-fbkeep-2000")
    drop = os.path.join(tempfile.gettempdir(), "codex-memory-fbdrop-2000")
    for d, days in ((keep, 3), (drop, 8)):
        os.makedirs(d, exist_ok=True)
        os.utime(d, (time.time() - days * 86400, time.time() - days * 86400))
    try:
        p = sb.run_ps1(clone, "-Pull")
        check(p.returncode == 0, p.stdout + p.stderr)
        check(os.path.isdir(keep), "3 天前备份在 7 天保留期下应保留")
        check(not os.path.isdir(drop), "8 天前备份应被清理")
    finally:
        shutil.rmtree(keep, ignore_errors=True)
        shutil.rmtree(drop, ignore_errors=True)


@sandboxed
def test_ps1_doctor_symmetric_probes(sb):
    """GAP-2-3 回归：ps1 -Doctor 须含「memory dir healthy（按 index.json）」与
    「local == remote」两项探针；memory 文件缺失时前者 FAIL 且 exit != 0。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    shutil.copy(os.path.join(REPO_ROOT, ".gitattributes"),
                os.path.join(clone, ".gitattributes"))
    p0 = sb.run_ps1(clone, "-Bootstrap")
    check(p0.returncode == 0, p0.stdout + p0.stderr)
    hook = os.path.join(sb.tmp, "AGENTS.md")
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("版本真值核对 = 触发式、禁自动化\n")
    with open(os.path.join(clone, "sync.config.ps1"), "a", encoding="utf-8") as fh:
        fh.write("$ConsumerHookFile = '%s'\n" % hook)
    p = sb.run_ps1(clone, "-Doctor")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("memory dir healthy" in p.stdout, "ps1 doctor 缺 memory dir healthy 探针")
    check("local == remote" in p.stdout, "ps1 doctor 缺 local == remote 探针")
    os.remove(os.path.join(clone, "memory", "状态.md"))
    p2 = sb.run_ps1(clone, "-Doctor")
    check(p2.returncode != 0, "memory 文件缺失时 doctor 应 FAIL")
    check("memory dir healthy" in p2.stdout and "FAIL" in p2.stdout,
          "memory dir healthy 探针应标红: " + p2.stdout)


@sandboxed
def test_ps1_doctor_local_behind_blocks(sb):
    """GAP-2-3 回归：本地落后远端时 ps1 -Doctor 的 local == remote 探针必须 FAIL
    并指引 re-pull。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    shutil.copy(os.path.join(REPO_ROOT, ".gitattributes"),
                os.path.join(clone, ".gitattributes"))
    sb.run_ps1(clone, "-Bootstrap")
    hook = os.path.join(sb.tmp, "AGENTS.md")
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("版本真值核对 = 触发式、禁自动化\n")
    with open(os.path.join(clone, "sync.config.ps1"), "a", encoding="utf-8") as fh:
        fh.write("$ConsumerHookFile = '%s'\n" % hook)
    other = sb.add_clone("other")
    with open(os.path.join(other, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n远端前进\n")
    git("add", "-A", cwd=other)
    git("commit", "-m", "advance", cwd=other)
    git("push", cwd=other)
    p = sb.run_ps1(clone, "-Doctor")
    check(p.returncode != 0, "本地落后远端时 doctor 应 FAIL")
    check("本地落后远端" in p.stdout, "应输出落后阻挡态: " + p.stdout)


@sandboxed
def test_py_doctor_ref_write_probe(sb):
    """GAP-2-3 回归：py doctor 须含 ref write persists 行为探针（沙盒健康态 PASS）。

    R3 P0-3：环境不支持 .git/refs 持久写入（沙盒 overlay）时探针必 FAIL ——
    该环境限制归因 ENV（SKIP），而非代码失败；支持环境仍必须 ALL PASS。
    """
    if not env_refs_write_persists():
        raise EnvSkip(
            "ENV: .git/refs 写入不持久（沙盒 overlay），探针健康态无法成立；"
            "环境限制归因 ENV，非代码失败")
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    hook = os.path.join(sb.tmp, "AGENTS-hook.md")
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("版本真值核对 = 触发式、禁自动化\n")
    cfg_path = os.path.join(os.path.dirname(script), "sync.config.json")
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg["consumer_memory_path"] = hook
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
    git("config", "core.autocrlf", "false", cwd=clone)
    git("config", "merge.union.driver", "git merge-file --union %A %O %B", cwd=clone)
    p = sb.run_py(script, "doctor")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("ref write persists (behavior probe)" in p.stdout, "py doctor 缺 ref 写入行为探针")
    check("doctor: ALL PASS" in p.stdout, p.stdout)


@sandboxed
def test_py_doctor_warns_missing_guards(sb):
    """GAP-3-4 回归：guards.json 缺失时 py doctor 输出 WARN 且 exit 0（警示不改退出码契约）。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    os.remove(os.path.join(clone, "guards.json"))
    hook = os.path.join(sb.tmp, "AGENTS-hook.md")
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("版本真值核对 = 触发式、禁自动化\n")
    cfg_path = os.path.join(os.path.dirname(script), "sync.config.json")
    with open(cfg_path, "r", encoding="utf-8") as fh:
        cfg = json.load(fh)
    cfg["consumer_memory_path"] = hook
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)
    git("config", "core.autocrlf", "false", cwd=clone)
    git("config", "merge.union.driver", "git merge-file --union %A %O %B", cwd=clone)
    p = sb.run_py(script, "doctor")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("guards.json 缺失" in p.stdout, "py doctor 缺 guards.json 缺失警示: " + p.stdout)


@sandboxed
def test_ps1_doctor_warns_missing_guards(sb):
    """GAP-3-4 回归：guards.json 缺失时 ps1 -Doctor 输出 WARN 且 exit 0。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    os.remove(os.path.join(clone, "guards.json"))
    shutil.copy(os.path.join(REPO_ROOT, ".gitattributes"),
                os.path.join(clone, ".gitattributes"))
    sb.run_ps1(clone, "-Bootstrap")
    hook = os.path.join(sb.tmp, "AGENTS.md")
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("版本真值核对 = 触发式、禁自动化\n")
    with open(os.path.join(clone, "sync.config.ps1"), "a", encoding="utf-8") as fh:
        fh.write("$ConsumerHookFile = '%s'\n" % hook)
    p = sb.run_ps1(clone, "-Doctor")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("guards.json 缺失" in p.stdout, "ps1 doctor 缺 guards.json 缺失警示: " + p.stdout)


def test_py_confirm_no_divergence_skips_redundant_fetch():
    """GAP-3-6 回归：远端对象已在本地时 confirm_no_divergence 不再二次 fetch；
    对象缺失（merge-base 报错码 >=128）时才 fetch 一次。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_nodiv", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    calls = []
    def fake_git(*args, **kwargs):
        calls.append(args)
        if args[0] == "merge-base":
            return (0, "", "")
        if args[0] == "fetch":
            return (0, "", "")
        if args[0] == "ls-remote":
            return (0, "cafebabecafebabecafebabecafebabecafebabe\trefs/heads/main", "")
        if args[0] == "rev-parse":
            return (0, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "")
        return (0, "", "")
    mod.git = fake_git
    ok, local, remote = mod.confirm_no_divergence()
    check(ok is True and local != remote, "非相等且祖先成立应返回 True")
    check(not any(a[0] == "fetch" for a in calls),
          "远端对象已在本地时不得 fetch: %r" % calls)
    # 对象缺失场景：merge-base 返回 128 → fetch 一次 → 再判定
    calls2 = []
    state = {"n": 0}
    def fake_git2(*args, **kwargs):
        calls2.append(args)
        if args[0] == "merge-base":
            state["n"] += 1
            return (0, "", "") if state["n"] == 2 else (128, "", "")
        if args[0] == "fetch":
            return (0, "", "")
        if args[0] == "ls-remote":
            return (0, "cafebabecafebabecafebabecafebabecafebabe\trefs/heads/main", "")
        if args[0] == "rev-parse":
            return (0, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "")
        return (0, "", "")
    mod.git = fake_git2
    ok2, _, _ = mod.confirm_no_divergence()
    check(ok2 is True, "对象缺失时应 fetch 后判定为祖先成立")
    check(len([a for a in calls2 if a[0] == "fetch"]) == 1,
          "对象缺失时只应 fetch 一次: %r" % calls2)


def test_agents_table_matches_index():
    """GAP-3-9 回归：AGENTS.md 第二节 L1–L6 表与 memory/index.json 双向一致
    （文件与标题段逐项包含，表内「」引用的段必须存在于 index.json）。"""
    idx = json.load(open(os.path.join(MEMORY, "index.json"), encoding="utf-8"))
    agents = open(AGENTS, encoding="utf-8").read()
    m = re.search(r"\| 类型 \| 内容 \| 召回范围[^\n]*\n\|[-| ]*\n((?:\|.*\n)+)", agents)
    check(m, "AGENTS.md 第二节表未找到")
    rows = {}
    for line in m.group(1).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        mm = re.match(r"^(L\d)", cells[0]) if cells else None
        if len(cells) >= 3 and mm:
            rows[mm.group(1)] = cells[2]
    for key in ("L1", "L2", "L3", "L4", "L5", "L6"):
        check(key in rows, "AGENTS 表缺 %s 行" % key)
        for entry in idx["recall"][key]:
            check(entry["file"] in rows[key],
                  "AGENTS %s 行缺文件 %s" % (key, entry["file"]))
            for sec in entry["sections"]:
                check(sec in rows[key],
                      "AGENTS %s 行缺段「%s」" % (key, sec))
        allowed = set()
        for entry in idx["recall"][key]:
            allowed.update(entry["sections"] or [])
        for q in re.findall(r"「([^」]+)」", rows[key]):
            check(q in allowed, "AGENTS %s 行含 index.json 未声明的段「%s」" % (key, q))


def test_version_pointer_consistent():
    """GAP-2-4 回归：VERSION 文件内容必须与 git tag 集合一致（带外真值源名称一致）。"""
    version = open(os.path.join(REPO_ROOT, "VERSION"), encoding="utf-8").read().strip()
    p = sh([GIT, "-C", REPO_ROOT, "tag", "-l"], check_fail=False)
    tags = [t for t in (p.stdout or "").splitlines() if t.strip()]
    check(tags, "仓库无任何 tag（带外真值源缺失）")
    check(version in tags, "VERSION=%r 不在 tag 集合 %r 中" % (version, tags))


def test_ps1_utf8_bom_preserved():
    """2026-08-17 P0 回归：sync-memory.ps1 必须保留 UTF-8 BOM。

    Windows PowerShell 5.1（Codex 端文档化运行环境）按 ANSI 解析无 BOM 的 UTF-8
    （zh-CN 代码页 936/GBK）：中文注释末字节落在 GBK lead 范围时会把换行吞入
    非法序列，导致注释行合并、后续代码行被吞，整脚本解析失败（DSH Sprint 3
    引入中文注释后实测 -Pull/-Doctor/-CommitRepo 全挂）。BOM 是 5.1 唯一可靠的
    UTF-8 识别标记；任何保存/编辑不得剥离。
    """
    with open(PS1, "rb") as fh:
        head = fh.read(3)
    check(head == b"\xef\xbb\xbf",
          "sync-memory.ps1 缺少 UTF-8 BOM（Windows PowerShell 5.1 无法解析，必须保留）")


def test_consumer_conformed_detects_triggertype_ban():
    # 纯函数单体测试：消费端操作记忆须声明「版本真值核对/触发式/禁自动化」三要素
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "sync_memory_conform", os.path.join(REPO_ROOT, "sync-memory.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check(mod.consumer_conformed("版本真值核对 / 触发式 / 禁自动化"),
          "三要素齐全应 conform")
    check(not mod.consumer_conformed("版本真值核对 / 触发式"),
          "缺禁自动化不应 conform")
    check(not mod.consumer_conformed("触发式 / 禁自动化"),
          "缺版本真值核对不应 conform")
    check(not mod.consumer_conformed(""), "空文本不应 conform")
    # C5 回归：语义反转（三要素齐全但被否定词否决）不得通过
    check(not mod.consumer_conformed(
        "本端不执行版本真值核对；触发式加载已废除；禁自动化条款作废。"),
        "语义反转（否定三要素）不应 conform")
    # C5 回归：消费记忆文件缺失/不可读 → fail-closed False
    check(not mod.consumer_conformed_file(
        os.path.join(REPO_ROOT, "definitely-not-exists-MEMORY.md")),
        "文件缺失应 fail-closed（False）")
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as fh:
        fh.write("版本真值核对=触发式、禁自动化\n")
        tmp_path = fh.name
    try:
        check(mod.consumer_conformed_file(tmp_path),
              "存在且声明三要素的文件应 conform")
    finally:
        os.unlink(tmp_path)


def test_guards_json_single_source():
    # 护栏契约单一事实源（措施9）：guards.json 存在且合法；py 生效密钥模式表
    # 必须等于 guards.json（证明从契约读取而非硬编码双写）。
    guards_path = os.path.join(REPO_ROOT, "guards.json")
    check(os.path.isfile(guards_path), "guards.json 必须存在（护栏契约单一事实源）")
    with open(guards_path, "r", encoding="utf-8") as fh:
        guards = json.load(fh)
    check(isinstance(guards.get("secret_patterns"), list)
          and len(guards["secret_patterns"]) == 5,
          "secret_patterns 应为 5 条")
    check(isinstance(guards.get("backup_retention_days"), int)
          and guards["backup_retention_days"] > 0,
          "backup_retention_days 应为正整数")
    check(guards["backup_retention_days"] == 7,
          "backup_retention_days 应为 7（GAP-2-1 机器口径统一，实现向基线收敛）")
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "sync_memory_guards", os.path.join(REPO_ROOT, "sync-memory.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    check(mod._SECRET_PATTERNS == guards["secret_patterns"],
          "py 生效密钥模式表应等于 guards.json（唯一事实源，防双写漂移）")


def test_repo_files_do_not_self_match_secret_patterns():
    # 防自命中误报：仓库文本（脚本/测试/文档/配置）不得出现可被 guards.json 扫描模式
    # 命中的字面样值（如掩码替换串、测试夹具）。否则 -CommitRepo 的 staged 扫描会把
    # 自己的代码当密钥拒绝提交。真实样例必须运行时拼接（见 test_redact_covers_all_guards_patterns）。
    guards = json.load(open(os.path.join(REPO_ROOT, "guards.json"), encoding="utf-8"))
    hits = []
    for root, _dirs, files in os.walk(REPO_ROOT):
        rel_root = os.path.relpath(root, REPO_ROOT)
        parts = set(rel_root.split(os.sep))
        if parts.intersection((".git", ".conflict-snapshots", "__pycache__", ".sites-runtime", "node_modules")):
            continue
        for name in files:
            if name.endswith(".pyc"):
                continue
            p = os.path.join(root, name)
            try:
                text = open(p, encoding="utf-8", errors="replace").read()
            except Exception:
                continue
            for pat in guards["secret_patterns"]:
                m = re.search(pat, text)
                if m:
                    hits.append("%s -> %r" % (os.path.relpath(p, REPO_ROOT), m.group(0)[:40]))
    check(not hits, "仓库文件自命中扫描模式（-CommitRepo 会被误拒）：\n" + "\n".join(hits))
def test_pid_alive_probe_does_not_kill():
    """P1-1 回归：_pid_alive 探活不得杀死被探测进程
    （旧实现 Windows 下 os.kill(pid, 0) = TerminateProcess）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_pid", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        check(mod._pid_alive(child.pid) is True, "存活子进程应判定为存活")
        check(child.poll() is None,
              "探活不得终止被探测进程（旧 os.kill(pid,0) 实现会杀进程）")
    finally:
        child.kill()
        child.wait()


def test_pid_alive_dead_pid_false():
    """P1-1 配套：不存在的 PID 应判定为不存活（探活而非误判）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("syncmem_pid2", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    probe = os.getpid() + 1_000_000_000
    if probe > 0xFFFFFFFF:
        probe = 999_999_999
    check(mod._pid_alive(probe) is False, "不存在的 PID 应判定为不存活")


def test_credential_policy_superseded_marked():
    """GAP-2-2 回归：决策.md 旧凭据口径（GITHUB_PAT_TOKEN/setx）必须标 superseded，
    不得与 vNext-1.3 新口径（gh 助手、不 setx）并存未标注。"""
    text = open(os.path.join(MEMORY, "决策.md"), encoding="utf-8").read()
    lines = [ln for ln in text.splitlines() if "GITHUB_PAT_TOKEN" in ln and "setx" in ln]
    check(lines, "决策.md 未找到旧凭据口径行")
    check(all("superseded" in ln for ln in lines),
          "旧凭据口径行必须标 superseded：%r" % lines)
    check("不 setx" in text or "不 setx 长期令牌" in text,
          "决策.md 应保留 vNext-1.3 新凭据口径")


def test_doc_conform_probe_not_stale():
    """P0-6 回归：基线第十二节不得残留「Codex 端无机器检查」的过期表述
    （ps1 conform 探针已于 DSH 接入轮补齐），且须登记 DSH 端探针对象。"""
    doc_path = os.path.join(REPO_ROOT, "架构基线文档-vNext-1.3.md")
    text = open(doc_path, encoding="utf-8").read()
    check("Codex 端无机器检查" not in text, "基线正文残留过期表述「Codex 端无机器检查」")
    check("~/.dsh/AGENTS.md" in text, "基线第十二节未登记 DSH 端 conform 探针对象")


# ===== Sprint 2：Protocol Behavior Manifest & Conformance =====

def _manifest():
    with open(MANIFEST_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def _matrix_row(rid):
    for r in _manifest()["conformance_matrix"]:
        if r["id"] == rid:
            return r
    raise AssertionError("manifest 缺 conformance_matrix 行: %s" % rid)


def _classify(exit_code, remote_changed):
    if exit_code != 0:
        return "block"
    return "allow" if remote_changed else "no-op"


def _check_conformance(row, py, ps1):
    """py/ps1 均为 (exit_code, remote_changed, marker_written)。对照 manifest 期望。"""
    for impl, obs in (("py", py), ("ps1", ps1)):
        exp = row[impl]
        got = _classify(obs[0], obs[1])
        check(got == exp["outcome"],
              "%s: %s 期望 %s 实得 %s（exit=%s remote_changed=%s）"
              % (row["id"], impl, exp["outcome"], got, obs[0], obs[1]))
        check(obs[1] == exp["remote_change"],
              "%s: %s remote_change 期望 %s 实得 %s"
              % (row["id"], impl, exp["remote_change"], obs[1]))
        if exp["outcome"] == "block":
            want_marker = row.get("marker", True)
            check(obs[2] == want_marker,
                  "%s: %s .sync-failed 期望 %s 实得 %s"
                  % (row["id"], impl, want_marker, obs[2]))


def test_protocol_manifest_wellformed():
    """Sprint2 回归：manifest 结构完整、conformance_matrix 行被测试覆盖、词汇合法。"""
    m = _manifest()
    check(m.get("schema_version") == 1, "schema_version 应为 1")
    for k in ("modes", "guards", "side_effects", "exit_codes",
              "remote_verification", "conformance_matrix"):
        check(k in m, "manifest 缺字段 %s" % k)
    check(set(m["modes"]) == {"pull", "push", "doctor", "bootstrap"},
          "modes 应为四模式")
    ids = [g["id"] for g in m["guards"]]
    check(len(ids) == len(set(ids)), "guard id 重复")
    for g in m["guards"]:
        check(g.get("py") and g.get("ps1") and g.get("desc"),
              "guard %s 缺 py/ps1/desc" % g.get("id"))
    check("0" in m["exit_codes"] and "1" in m["exit_codes"],
          "exit_codes 应声明 0/1")
    check(m["remote_verification"].get("rule") and m["remote_verification"].get("method"),
          "remote_verification 缺 rule/method")
    valid = {"allow", "no-op", "block"}
    for row in m["conformance_matrix"]:
        rid = row["id"]
        check(rid.isidentifier(), "row id 非法: %s" % rid)
        check(row["py"]["outcome"] in valid and row["ps1"]["outcome"] in valid,
              "%s: outcome 词汇非法" % rid)
        check(isinstance(row["py"].get("remote_change"), bool)
              and isinstance(row["ps1"].get("remote_change"), bool),
              "%s: remote_change 应为 bool" % rid)
        check(callable(globals().get("test_conformance_" + rid)),
              "matrix 行 %s 无对应 conformance 测试 test_conformance_%s" % (rid, rid))


@sandboxed
def test_conformance_access_none(sb):
    row = _matrix_row("access_none")
    a, b = sb.add_clone("a"), sb.add_clone("b")
    sa, sbb = sb.install_py(a), sb.install_py(b)
    with open(os.path.join(a, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n远端状态\n")
    git("add", "-A", cwd=a)
    git("commit", "-m", "v", cwd=a)
    check(sb.run_py(sa, "push").returncode == 0, "py A push 失败")
    p = sb.run_py(sbb, "pull", "NONE")
    check(p.returncode == 0, p.stdout + p.stderr)
    py_remote = sb.remote_head()
    py_local = git("rev-parse", "HEAD", cwd=b).stdout.strip()
    check(py_local != py_remote, "py NONE 不应拉取远端")
    py = (p.returncode, py_local == py_remote, os.path.isfile(os.path.join(b, ".sync-failed")))
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    with open(os.path.join(clone, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n脏变更\n")
    p2 = sb.run_ps1(clone, "-Pull", "-Access", "NONE")
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    check("skipping pull" in p2.stdout, p2.stdout)
    ps1 = (p2.returncode, False, os.path.isfile(os.path.join(clone, ".sync-failed")))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_no_memory_change(sb):
    row = _matrix_row("no_memory_change")
    a = sb.add_clone("a")
    sa = sb.install_py(a)
    before = sb.remote_head()
    p = sb.run_py(sa, "push")
    check(p.returncode == 0, p.stdout + p.stderr)
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(os.path.join(a, ".sync-failed")))
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before2 = sb.remote_head()
    p2 = sb.run_ps1(clone)
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    ps1 = (p2.returncode, sb.remote_head() != before2, os.path.isfile(os.path.join(clone, ".sync-failed")))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_staged_non_memory(sb):
    row = _matrix_row("staged_non_memory")
    a = sb.add_clone("a")
    sa = sb.install_py(a)
    before = sb.remote_head()
    with open(os.path.join(a, "README_x.md"), "w", encoding="utf-8") as fh:
        fh.write("pre-staged\n")
    git("add", "README_x.md", cwd=a)
    with open(os.path.join(a, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n触发\n")
    git("commit", "-m", "mem", "--", "memory", cwd=a)
    p = sb.run_py(sa, "push")
    check(p.returncode == 0, p.stdout + p.stderr)
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(os.path.join(a, ".sync-failed")))
    c1 = os.path.join(sb.tmp, "chk1")
    sh([GIT, "clone", sb.remote, c1])
    check(not os.path.isfile(os.path.join(c1, "README_x.md")),
          "py: 预 staged 非 memory 文件不得上远端")
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before2 = sb.remote_head()
    with open(os.path.join(clone, "AGENTS.md"), "w", encoding="utf-8") as fh:
        fh.write("# tampered\n")
    git("add", "AGENTS.md", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n触发\n")
    p2 = sb.run_ps1(clone)
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    ps1 = (p2.returncode, sb.remote_head() != before2, os.path.isfile(os.path.join(clone, ".sync-failed")))
    c2 = os.path.join(sb.tmp, "chk2")
    sh([GIT, "clone", sb.remote, c2])
    check("tampered" not in open(os.path.join(c2, "AGENTS.md"), encoding="utf-8").read(),
          "ps1: 预 staged 非 memory 文件不得上远端")
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_staged_secret(sb):
    row = _matrix_row("staged_secret")
    tok = "ghp_" + "A" * 32
    a = sb.add_clone("a")
    sa = sb.install_py(a)
    before = sb.remote_head()
    with open(os.path.join(a, "README_secret.md"), "w", encoding="utf-8") as fh:
        fh.write(tok + "\n")
    git("add", "README_secret.md", cwd=a)
    with open(os.path.join(a, "README_secret.md"), "w", encoding="utf-8") as fh:
        fh.write("clean\n")
    with open(os.path.join(a, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n触发\n")
    git("commit", "-m", "mem", "--", "memory", cwd=a)
    p = sb.run_py(sa, "push")
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(os.path.join(a, ".sync-failed")))
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before2 = sb.remote_head()
    with open(os.path.join(clone, "README_secret.md"), "w", encoding="utf-8") as fh:
        fh.write(tok + "\n")
    git("add", "README_secret.md", cwd=clone)
    with open(os.path.join(clone, "README_secret.md"), "w", encoding="utf-8") as fh:
        fh.write("clean\n")
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n触发\n")
    p2 = sb.run_ps1(clone)
    ps1 = (p2.returncode, sb.remote_head() != before2, os.path.isfile(os.path.join(clone, ".sync-failed")))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_committed_non_memory_secret(sb):
    row = _matrix_row("committed_non_memory_secret")
    tok = "ghp_" + "A" * 32
    a = sb.add_clone("a")
    sa = sb.install_py(a)
    before = sb.remote_head()
    with open(os.path.join(a, "README_token.md"), "w", encoding="utf-8") as fh:
        fh.write(tok + "\n")
    git("add", "README_token.md", cwd=a)
    git("commit", "-m", "token", cwd=a)
    p = sb.run_py(sa, "push")
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(os.path.join(a, ".sync-failed")))
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before2 = sb.remote_head()
    with open(os.path.join(clone, "README_token.md"), "w", encoding="utf-8") as fh:
        fh.write(tok + "\n")
    git("add", "README_token.md", cwd=clone)
    git("commit", "-m", "token", cwd=clone)
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n触发\n")
    p2 = sb.run_ps1(clone)
    ps1 = (p2.returncode, sb.remote_head() != before2, os.path.isfile(os.path.join(clone, ".sync-failed")))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_missing_config(sb):
    row = _matrix_row("missing_config")
    a = sb.add_clone("a")
    script = os.path.join(a, "sync-memory.py")  # 克隆内、无 sync.config.json
    shutil.copy(PY, script)
    before = sb.remote_head()
    with open(os.path.join(a, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n无配置推送\n")
    git("add", "-A", "--", "memory", cwd=a)
    git("commit", "-m", "noconfig", cwd=a)
    p = sh([sys.executable, script, "push"], cwd=a, check_fail=False)
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(os.path.join(a, ".sync-failed")))
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    os.remove(os.path.join(clone, "sync.config.ps1"))  # 无配置
    p2 = sb.run_ps1(clone, "-Pull", "-Access", "NONE")
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    ps1 = (p2.returncode, False, os.path.isfile(os.path.join(clone, ".sync-failed")))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_foreign_mirror(sb):
    row = _matrix_row("foreign_mirror")
    codexdir = os.path.join(sb.tmp, ".codex", "projects", "codex-memory-system")
    os.makedirs(codexdir, exist_ok=True)
    pyscript = os.path.join(codexdir, "sync-memory.py")
    shutil.copy(PY, pyscript)
    p = sh([sys.executable, pyscript, "pull"], cwd=codexdir, check_fail=False)
    check(p.returncode != 0, "py 在 .codex 路径应被拒")
    check("[deploy-guard]" in (p.stdout + p.stderr), "py 应输出 deploy-guard")
    py = (p.returncode, False, os.path.isfile(os.path.join(codexdir, ".sync-failed")))
    wbdir = os.path.join(sb.tmp, ".workbuddy", "codex-memory-system")
    os.makedirs(wbdir, exist_ok=True)
    ps1script = os.path.join(wbdir, "sync-memory.ps1")
    shutil.copy(PS1, ps1script)
    p2 = sh([POWERSHELL, "-ExecutionPolicy", "Bypass", "-File", ps1script, "-Doctor"],
            cwd=wbdir, check_fail=False)
    check(p2.returncode != 0, "ps1 在 .workbuddy 路径应被拒")
    check("[deploy-guard]" in p2.stdout, "ps1 应输出 deploy-guard")
    ps1 = (p2.returncode, False, os.path.isfile(os.path.join(wbdir, ".sync-failed")))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_fetch_error_redact(sb):
    row = _matrix_row("fetch_error_redact")
    tok = "ghp_" + "A" * 32
    bad_py = os.path.join(sb.tmp, "gone-" + tok + ".git")
    a = sb.add_clone("a")
    sa = sb.install_py(a)
    git("remote", "set-url", "origin", bad_py, cwd=a)
    before = sb.remote_head()
    p = sb.run_py(sa, "pull")
    check(tok not in (p.stdout + p.stderr), "py 输出不得含令牌")
    marker = os.path.join(a, ".sync-failed")
    if os.path.isfile(marker):
        check(tok not in open(marker, encoding="utf-8", errors="replace").read(),
              "py .sync-failed 不得含令牌")
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(marker))
    bad_ps1 = os.path.join(sb.tmp, "gone-" + tok + ".git2")
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    git("remote", "set-url", "origin", bad_ps1, cwd=clone)
    before2 = sb.remote_head()
    p2 = sb.run_ps1(clone, "-Pull")
    check(tok not in (p2.stdout + p2.stderr), "ps1 输出不得含令牌")
    marker2 = os.path.join(clone, ".sync-failed")
    if os.path.isfile(marker2):
        check(tok not in open(marker2, encoding="utf-8", errors="replace").read(),
              "ps1 .sync-failed 不得含令牌")
    ps1 = (p2.returncode, sb.remote_head() != before2, os.path.isfile(marker2))
    _check_conformance(row, py, ps1)


@sandboxed
def test_conformance_remote_verification(sb):
    row = _matrix_row("remote_verification")
    a = sb.add_clone("a")
    sa = sb.install_py(a)
    before = sb.remote_head()
    with open(os.path.join(a, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n验证\n")
    git("add", "-A", "--", "memory", cwd=a)
    git("commit", "-m", "v", cwd=a)
    p = sb.run_py(sa, "push")
    check(p.returncode == 0, p.stdout + p.stderr)
    py_ok = sb.remote_head() == git("rev-parse", "HEAD", cwd=a).stdout.strip()
    check(py_ok, "py push 后本地应等于远端")
    py = (p.returncode, sb.remote_head() != before, os.path.isfile(os.path.join(a, ".sync-failed")))
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    before2 = sb.remote_head()
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n验证\n")
    p2 = sb.run_ps1(clone)
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    ps1_ok = sb.remote_head() == git("rev-parse", "HEAD", cwd=clone).stdout.strip()
    check(ps1_ok, "ps1 push 后本地应等于远端")
    ps1 = (p2.returncode, sb.remote_head() != before2, os.path.isfile(os.path.join(clone, ".sync-failed")))
    _check_conformance(row, py, ps1)


def test_doc_guard_wording_consistent():
    """P1-2 回归：协议文档不得残留硬编码 .md 数量护栏旧口径（≥ 5），
    护栏口径唯一事实源是 memory/index.json 的 files 清单。
    GAP-3-2/3-3 回归：README 端侧差异表须含 DSH 列；配置手册旧流程须带行内「已废弃」。"""
    readme = open(os.path.join(REPO_ROOT, "README.md"), encoding="utf-8").read()
    agents = open(AGENTS, encoding="utf-8").read()
    manual = open(os.path.join(REPO_ROOT, "配置手册与数据包-v4.md"),
                  encoding="utf-8").read()
    for name, text in (("README.md", readme), ("AGENTS.md", agents)):
        check("≥ 5" not in text, "%s 残留「≥ 5」硬编码护栏旧口径" % name)
        check(">= 5" not in text, "%s 残留「>= 5」硬编码护栏旧口径" % name)
        check(".md ≥" not in text, "%s 残留「.md ≥」硬编码护栏旧口径" % name)
    # Codex 端消费钩子文本须含 conform 三要素（ps1 doctor 探针判据）
    for m in ("版本真值核对", "触发式", "禁自动化"):
        check(m in agents, "AGENTS.md 须含 conform 三要素之一: %s" % m)
    # GAP-3-2：README 端侧差异表补 DSH 列
    check("端侧差异（Codex / WorkBuddy / DSH）" in readme,
          "README 端侧差异表未登记 DSH 列")
    # GAP-3-3：配置手册旧流程行须带行内「已废弃」注记
    check("已废弃" in manual, "配置手册旧流程行缺「已废弃」行内注记")


@sandboxed
def test_py_needs_push_cleared_after_push(sb):
    """P1-3 回归（py 侧）：本地领先 → pull 写 .needs-push → 显式 push 成功后标记清除。"""
    clone = sb.add_clone("a")
    script = sb.install_py(clone)
    with open(os.path.join(clone, "memory", "状态.md"), "a", encoding="utf-8") as fh:
        fh.write("\n领先的本地提交\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "local ahead", cwd=clone)
    p = sb.run_py(script, "pull")
    check(p.returncode == 0, p.stdout + p.stderr)
    marker = os.path.join(clone, ".needs-push")
    check(os.path.isfile(marker), "领先时 pull 应写 .needs-push 标记")
    p2 = sb.run_py(script, "push")
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    check(not os.path.exists(marker), "push 成功后应清除 .needs-push 标记")


@sandboxed
def test_py_deploy_guard_blocks_codex_path(sb):
    """P2-9 回归（机制补齐）：py 拒绝在 .codex 克隆路径内运行（对称 ps1 deploy-guard）。"""
    codexdir = os.path.join(sb.tmp, ".codex", "projects", "codex-memory-system")
    os.makedirs(codexdir, exist_ok=True)
    script = os.path.join(codexdir, "sync-memory.py")
    shutil.copy(PY, script)
    p = sh([sys.executable, script, "pull"], cwd=codexdir, check_fail=False)
    check(p.returncode != 0, "在 .codex 路径执行必须被拒绝")
    check("[deploy-guard]" in (p.stdout + p.stderr), "应输出 deploy-guard 标记")


@sandboxed
def test_ps1_conform_probe_detects(sb):
    """P1-4 回归：ps1 -Doctor 的消费端 conform 探针——三要素齐全 PASS、缺失 FAIL。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    # 沙盒克隆无 .gitattributes 与 bootstrap 配置，先补齐再跑 doctor，
    # 否则 doctor 会卡在 core.autocrlf / union driver 等无关项上。
    shutil.copy(os.path.join(REPO_ROOT, ".gitattributes"),
                os.path.join(clone, ".gitattributes"))
    p0 = sb.run_ps1(clone, "-Bootstrap")
    check(p0.returncode == 0, p0.stdout + p0.stderr)
    hook = os.path.join(sb.tmp, "AGENTS.md")
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("版本真值核对 = 触发式、禁自动化\n")
    cfg = os.path.join(clone, "sync.config.ps1")
    with open(cfg, "a", encoding="utf-8") as fh:
        fh.write("$ConsumerHookFile = '%s'\n" % hook)
    p = sb.run_ps1(clone, "-Doctor")
    check(p.returncode == 0, p.stdout + p.stderr)
    check("consumer hook conform" in p.stdout, p.stdout)
    with open(hook, "w", encoding="utf-8") as fh:
        fh.write("只有触发式，没有版本真值核对\n")
    p2 = sb.run_ps1(clone, "-Doctor")
    check(p2.returncode != 0, "消费端缺 conform 三要素时 doctor 应 FAIL（阻断态）")
    check("consumer hook conform" in p2.stdout, p2.stdout)


@sandboxed
def test_ps1_needs_push_cleared_after_push(sb):
    """P1-3 回归（ps1 侧）：-Pull 领先写 .needs-push → 默认同步推送成功后清除。"""
    clone = sb.add_clone("repo")
    workdir = os.path.join(sb.tmp, "working")
    sb.install_ps1(clone, workdir)
    with open(os.path.join(clone, "memory", "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n克隆内领先提交\n")
    git("add", "-A", cwd=clone)
    git("commit", "-m", "clone ahead", cwd=clone)
    shutil.copy(os.path.join(clone, "memory", "画像.md"),
                os.path.join(workdir, "画像.md"))
    p = sb.run_ps1(clone, "-Pull")
    check(p.returncode == 0, p.stdout + p.stderr)
    marker = os.path.join(clone, ".needs-push")
    check(os.path.isfile(marker), "-Pull 领先时应写 .needs-push 标记")
    with open(os.path.join(workdir, "画像.md"), "a", encoding="utf-8") as fh:
        fh.write("\n工作区新变更\n")
    before = sb.remote_head()
    p2 = sb.run_ps1(clone)
    check(p2.returncode == 0, p2.stdout + p2.stderr)
    check("Memory synced" in p2.stdout, p2.stdout)
    check(sb.remote_head() != before, "应产生新推送")
    check(not os.path.exists(marker), "推送成功后应清除 .needs-push 标记")


TESTS = [
    test_index_json_recall_mapping_valid,
    test_redact_masks_tokens,
    test_redact_covers_all_guards_patterns,
    test_ps1_no_change_skips_commit,
    test_ps1_change_commits_and_pushes,
    test_ps1_secret_scan_blocks,
    test_ps1_commit_repo_commits_docs,
    test_ps1_push_scopes_to_index_files,
    test_ps1_push_prestaged_non_memory_not_committed,
    test_ps1_push_no_change_with_prestaged_skips,
    test_ps1_push_refuses_staged_secret_non_memory,
    test_ps1_pull_pending_writeback_keeps_extras_and_backup,
    test_py_push_is_idempotent,
    test_py_concurrent_merge_no_loss,
    test_py_sync_failure_writes_marker_and_retries,
    test_py_pull_aligns_to_remote,
    test_py_delete_propagation_guard,
    test_py_missing_index_guard,
    test_py_secret_scan_blocks_push,
    test_py_push_refuses_staged_secret_index_blob,
    test_py_push_refuses_committed_non_memory_secret,
    test_py_push_allows_clean_non_memory_commit,
    test_py_access_none_skips_pull,
    test_py_lock_blocks_concurrent,
    test_py_repo_defaults_to_script_dir,
    test_py_lock_stale_pid_cleared,
    test_py_dangling_ref_rejected,
    test_py_pull_ahead_self_heals,
    test_ps1_pull_fails_closed_on_bad_remote,
    test_ps1_deploy_guard_blocks_workbuddy_path,
    test_ps1_deploy_guard_blocks_dsh_path,
    test_py_fetch_error_output_redacted,
    test_py_consumer_memory_path_config,
    test_consumer_conformed_detects_triggertype_ban,
    test_guards_json_single_source,
    test_py_retention_fallback_defaults_to_7,
    test_ps1_retention_fallback_defaults_to_7,
    test_repo_files_do_not_self_match_secret_patterns,
    test_pid_alive_probe_does_not_kill,
    test_pid_alive_dead_pid_false,
    test_doc_conform_probe_not_stale,
    test_credential_policy_superseded_marked,
    test_doc_guard_wording_consistent,
    test_py_needs_push_cleared_after_push,
    test_py_deploy_guard_blocks_codex_path,
    test_ps1_conform_probe_detects,
    test_ps1_needs_push_cleared_after_push,
    test_ps1_doctor_symmetric_probes,
    test_ps1_doctor_local_behind_blocks,
    test_py_doctor_ref_write_probe,
    test_ps1_push_refuses_committed_non_memory_secret,
    test_ps1_push_allows_clean_non_memory_commit,
    test_ps1_pull_access_none_pure_shortcircuit,
    test_ps1_doctor_warns_missing_guards,
    test_ps1_utf8_bom_preserved,
    test_py_confirm_no_divergence_skips_redundant_fetch,
    test_agents_table_matches_index,
    test_version_pointer_consistent,
    test_py_index_path_traversal_rejected,
    test_ps1_index_path_traversal_rejected,
    test_protocol_manifest_wellformed,
    test_conformance_access_none,
    test_conformance_no_memory_change,
    test_conformance_staged_non_memory,
    test_conformance_staged_secret,
    test_conformance_committed_non_memory_secret,
    test_conformance_missing_config,
    test_conformance_foreign_mirror,
    test_conformance_fetch_error_redact,
    test_conformance_remote_verification,
]


def main():
    failures = 0
    skipped = 0
    ps1_blocked = bool(POWERSHELL) and _ps1_git_unsafe()
    for fn in TESTS:
        name = fn.__name__
        if ("ps1" in name or name.startswith("test_conformance_")) \
                and name != "test_ps1_deploy_guard_blocks_workbuddy_path":
            if not POWERSHELL:
                print("SKIP %s (PowerShell 不可用)" % name)
                skipped += 1
                continue
            if ps1_blocked:
                print("SKIP %s (环境 git 客户端不安全，将被 ps1 护栏拦截；请前置官方 Git 后重跑以覆盖)" % name)
                skipped += 1
                continue
        try:
            fn()
            print("PASS %s" % name)
        except EnvSkip as e:
            print("SKIP %s (%s)" % (name, e))
            skipped += 1
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (name, e))
    print("----")
    print("%d test(s), %d failure(s), %d skipped" % (len(TESTS), failures, skipped))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
