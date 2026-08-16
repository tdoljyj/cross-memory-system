#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 侧记忆同步脚本（Python 版）

模块定位（对齐《架构基线文档-vNext.md》vNext-1.3）：本脚本 = WorkBuddy 端 AI Adapter
的 Sync Layer 实现，只与 Canonical Memory Store（本 git 仓库）同步，不与其他端互相同步。
按需触发：命中 Memory Router（AGENTS v3 / MEMORY.md 的 T1–T4）才 pull；本轮产生记忆
写入才 push。NO_CHANGE → NO_WRITE → NO_SYNC。

背景（2026-08-16 根因实锤）：
    WorkBuddy 沙盒 overlay 拦截 git 的 lockfile+rename 原子写，
    两层 ref（refs/remotes/origin/main）写不进（exit 0 静默失败、还清空父目录）。
    单层 ref（refs/heads/main）正常；Python os.makedirs+open 直写正常（不走 rename）。

策略（根治方向 2 + 3）：
    - git 只负责对象传输（fetch/merge/push），Python 负责 tracking ref 兜底写入
    - 显式 origin main，不依赖 tracking ref
    - 一切以 ls-remote 为准，不信 git status 的 ahead/behind / gone

收敛策略（2026-08-16 修正，实测 E1~E4 支撑）：
    - 全仓统一 git merge（非 rebase）。实测 rebase + union driver 会静默丢单边内容
      （exit 0 假成功），merge + union driver 才能正确自动合并归档.md。
    - 归档.md 配 merge=union（.gitattributes 已设 + 本机 merge.union.driver 已配），
      两端追加自动保留；其余文件冲突时语义合并。
    - merge 走 FETCH_HEAD（不受沙盒 tracking ref 失效影响）。

用法：
    python sync-memory.py pull      # 开场：fetch + merge 对齐 + 补写 tracking ref + 核验
    python sync-memory.py push      # 收尾：fetch + merge 对齐 + push + 补写 tracking ref + 核验
    python sync-memory.py doctor    # 体检：git / 远端 / refs / 残留标记 / union 配置

注意：
    - commit 不在本脚本职责内（由使用方在改完记忆后自行 commit，再跑 push 模式）
    - git 写操作需在非沙盒环境执行，判据=输出尾 "Sandbox bypassed"；
      沙盒内 git 写对象可能不落真实盘，跑完用 doctor 核验
    - 可选 sync.config.json（与脚本同目录，gitignored）：{repo, proxy, proxy_host,
      proxy_port, git_candidates}，缺省用内置默认值
    - 删除传播护栏：memory/index.json 声明的 .md 缺失或为空时拒绝 pull/push，防推空仓
    - push/pull 后核验用 merge-base --is-ancestor（祖先判定），非 == 比较
"""

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime

_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "sync.config.json")


def _load_config():
    cfg = {}
    if os.path.isfile(_CONFIG_PATH):
        try:
            with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    return cfg if isinstance(cfg, dict) else {}


_CONFIG = _load_config()

REPO = os.path.expanduser(_CONFIG.get("repo", "~/.workbuddy/codex-memory-system"))
PROXY = _CONFIG.get("proxy", "http://127.0.0.1:7897")  # 无代理时设为 ""
PROXY_HOST = _CONFIG.get("proxy_host", "127.0.0.1")
try:
    PROXY_PORT = int(_CONFIG.get("proxy_port", 7897))
except (TypeError, ValueError):
    PROXY_PORT = 7897

# git 优先级：官方 Git for Windows（真非沙盒下健康）> PortableGit（PATH 兜底）
GIT_CANDIDATES = _CONFIG.get(
    "git_candidates",
    ["C:/Program Files/Git/bin/git.exe", "C:/Program Files/Git/cmd/git.exe"],
)


def find_git():
    for c in GIT_CANDIDATES:
        if os.path.isfile(c):
            return os.path.abspath(c)
    resolved = shutil.which("git")
    if resolved:
        return os.path.abspath(resolved)
    return "git"


GIT = find_git()


def git_is_safe(path=None):
    p = (path or GIT).lower()
    return "portablegit" not in p and ".workbuddy" not in p


def ensure_git_safe():
    if not git_is_safe():
        print("[!] 检测到不安全的 PortableGit: %s" % GIT)
        write_marker(".sync-failed", "unsafe git client: %s" % GIT)
        sys.exit(1)


def proxy_alive():
    """代理端口探测，3 秒快失败。WorkBuddy 沙箱内出网仅代理路径，
    代理不在时应快速失败而非让 git 卡 20 秒。"""
    try:
        with socket.create_connection((PROXY_HOST, PROXY_PORT), timeout=3.0):
            return True
    except Exception:
        return False


def run(cmd, cwd=REPO, timeout=60):
    try:
        p = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return -1, "", "git 命令超时（%ds）" % timeout
    return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()


def git(*args, proxy=True):
    cmd = [GIT]
    if proxy and PROXY:
        cmd += ["-c", "http.proxy=%s" % PROXY, "-c", "http.sslBackend=openssl"]
    cmd += list(args)
    return run(cmd)


def write_ref(name, refhash):
    """Python 直写 ref（绕过沙盒 overlay 的 rename 拦截）。name 用 '/' 分隔。"""
    full = os.path.join(REPO, ".git", *name.split("/"))
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", newline="", encoding="ascii") as f:
        f.write(refhash + "\n")
        f.flush()
        os.fsync(f.fileno())
    with open(full, "r", encoding="ascii") as f:
        return f.read().strip() == refhash


def ls_remote():
    code, out, err = git("ls-remote", "origin", "main")
    if code != 0:
        print("[!] ls-remote 失败: %s" % redact(err))
        return None
    if not out.strip():
        print("[!] ls-remote 空输出（远端可能无 main 分支）")
        return None
    return out.split()[0]


def local_head():
    code, out, _ = git("rev-parse", "HEAD", proxy=False)
    return out if code == 0 else None


def load_index():
    """读取 memory/index.json（文件集 + L1-L6 召回映射的单一事实源）。"""
    path = os.path.join(REPO, "memory", "index.json")
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        return None
    return data


def memory_files():
    idx = load_index()
    if not idx:
        return None
    files = [str(f) for f in idx.get("files", [])]
    return files or None


def memory_dir_healthy():
    """删除传播护栏：memory/index.json 声明的每个 .md 都必须存在且非空。"""
    required = memory_files()
    if not required:
        return False
    memdir = os.path.join(REPO, "memory")
    for f in required:
        p = os.path.join(memdir, f)
        if not os.path.isfile(p) or os.path.getsize(p) == 0:
            return False
    return True


_TOKEN_RE = re.compile(
    r"(?i)(bearer\s+)[A-Za-z0-9._-]+"
    r"|gho_[A-Za-z0-9]+"
    r"|ghp_[A-Za-z0-9]+"
    r"|github_pat_[A-Za-z0-9_]+"
)


def redact(text):
    """掩码凭据样值（gho_/ghp_/github_pat_/Bearer），不落到输出或 .sync-failed。"""
    if not text:
        return text

    def mask(m):
        token = m.group(0)
        low = token.lower()
        if low.startswith("bearer "):
            return token.split()[0] + " ***"
        if token.startswith("gho_"):
            return "gho_***"
        if token.startswith("ghp_"):
            return "ghp_***"
        if token.startswith("github_pat_"):
            return "github_pat_***"
        return token

    return _TOKEN_RE.sub(mask, text)


_SECRET_PATTERNS = [
    r"gh[op]_[A-Za-z0-9]{20,}",
    r"github_pat_[A-Za-z0-9_]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    r"(?i)bearer\s+[A-Za-z0-9._-]{20,}",
]


def _lock_path():
    return os.path.join(REPO, ".sync.lock")


def _pid_alive(pid):
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_lock():
    """Cross-process advisory lock: serialize concurrent pull/push on the same clone."""
    path = _lock_path()
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, str(os.getpid()).encode("ascii"))
            finally:
                os.close(fd)
            return True
        except FileExistsError:
            holder = None
            try:
                with open(path, "r", encoding="ascii") as f:
                    holder = int(f.read().strip() or 0)
            except Exception:
                holder = None
            if _pid_alive(holder):
                return False
            try:
                os.remove(path)
            except OSError:
                return False
    return False


def release_lock():
    try:
        if os.path.exists(_lock_path()):
            os.remove(_lock_path())
    except OSError:
        pass


def find_secret_leak(memdir):
    """Pre-commit secret scan: refuse to sync memory files carrying credential-like values."""
    if not os.path.isdir(memdir):
        return None
    for name in sorted(os.listdir(memdir)):
        if not name.endswith(".md"):
            continue
        try:
            with open(os.path.join(memdir, name), "r", encoding="utf-8") as f:
                text = f.read()
        except Exception:
            continue
        for pat in _SECRET_PATTERNS:
            if re.search(pat, text):
                return name
    return None


def confirm_no_divergence():
    """本地 HEAD 是否落在远端 main 祖先链上（含相等）。非分叉即视为安全。

    与 sync-memory.ps1 的 Confirm-RemotePushed 对齐：用 merge-base --is-ancestor，
    而非 == 比较，避免并发 push 下本地落后于远端时误报不一致、误写 .sync-failed。
    """
    local = local_head()
    remote = ls_remote()
    if not local or not remote:
        return False, local, remote
    if local == remote:
        return True, local, remote
    git("fetch", "origin", "main")  # 确保远端对象在本地，merge-base 才能判定
    code, _, _ = git("merge-base", "--is-ancestor", local, remote, proxy=False)
    return code == 0, local, remote


def git_status_memory():
    code, out, _ = git("status", "--porcelain", "--", "memory", proxy=False)
    if code != 0:
        return None
    return [line for line in out.splitlines() if line.strip()]


def is_working_tree_dirty():
    lines = git_status_memory()
    return lines is None or bool(lines)


def marker_path(name):
    return os.path.join(REPO, name)


def write_marker(name, message):
    try:
        with open(marker_path(name), "w", encoding="utf-8") as f:
            f.write("Failed: %s\n%s\n" % (
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"), redact(message)))
    except Exception as e:
        print("[!] 写 %s 失败: %s" % (name, redact(str(e))))


def clear_marker(name):
    try:
        if os.path.exists(marker_path(name)):
            os.remove(marker_path(name))
    except Exception as e:
        print("[!] 清除 %s 失败: %s" % (name, e))


def cleanup_stale_backups(retention_days=2):
    """清理过期的 codex-memory-* 临时备份目录（只增不减的历史债务）。"""
    tmp = tempfile.gettempdir()
    cutoff = time.time() - retention_days * 86400
    try:
        for name in os.listdir(tmp):
            if not name.startswith("codex-memory-"):
                continue
            p = os.path.join(tmp, name)
            if not os.path.isdir(p):
                continue
            if os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
    except Exception:
        pass


def backup_conflict():
    code, out, _ = git(
        "-c", "core.quotepath=false", "diff", "--name-only",
        "--diff-filter=U", "--", "memory", proxy=False)
    if code != 0 or not out.strip():
        return None
    dest = os.path.join(
        tempfile.gettempdir(),
        "codex-memory-conflict-" + datetime.now().strftime("%Y%m%d-%H%M%S"))
    os.makedirs(dest, exist_ok=True)
    for raw in out.splitlines():
        rel = raw.strip()
        if not rel:
            continue
        safe = os.path.basename(rel)
        for stage, spec in (("base", ":1"), ("ours", ":2"), ("theirs", ":3")):
            c, data, _ = git("show", "%s:%s" % (spec, rel), proxy=False)
            if c == 0:
                with open(os.path.join(dest, "%s.%s.md" % (safe, stage)),
                          "w", encoding="utf-8", newline="") as fh:
                    fh.write(data)
        src = os.path.join(REPO, *rel.split("/"))
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(dest, safe + ".conflict.md"))
    return dest


def restore_tracking_ref(remote):
    """补写 refs/remotes/origin/main，让 git status 干净。"""
    if not remote:
        return False
    ok = write_ref("refs/remotes/origin/main", remote)
    print("[ref] 补写 refs/remotes/origin/main = %s  %s"
          % (remote[:12], "OK" if ok else "FAIL"))
    return ok


def fetch_and_merge():
    """fetch 后 merge FETCH_HEAD（非 rebase）。返回是否成功对齐。"""
    code, out, err = git("fetch", "origin", "main")
    print("[fetch] %s" % ("OK" if code == 0 else "FAIL: " + err))
    if code != 0:
        return False
    code, out, err = git("merge", "--no-edit", "FETCH_HEAD")
    if out:
        print(out)
    if err:
        print(redact(err))
    if code != 0:
        print("[!] merge 冲突（code=%d），执行 --abort 清理中间态" % code)
        snap = backup_conflict()
        if snap:
            print("[conflict-snapshot] %s" % snap)
        git("merge", "--abort", proxy=False)
        return False
    return True


def cmd_pull(access=""):
    print("== 开场拉取对齐 ==")
    ensure_git_safe()
    cleanup_stale_backups()
    if access.strip().upper() == "NONE":
        print("Memory Access = NONE; 按需读取判定为无关，跳过 pull")
        return
    if not proxy_alive() and PROXY:
        print("[!] 代理 %s 不可达（Clash 未启动？），终止以免 git 卡死" % PROXY)
        write_marker(".sync-failed", "pull aborted: proxy %s unreachable" % PROXY)
        sys.exit(1)
    if not memory_dir_healthy():
        print("[!] memory 目录缺少 memory/index.json 声明的必需文件或文件为空（删除传播护栏），终止 pull")
        write_marker(".sync-failed", "pull aborted: missing/empty required files per memory/index.json")
        sys.exit(1)
    if not acquire_lock():
        print("[!] 已有另一同步进程持锁，拒绝并发 pull")
        write_marker(".sync-failed", "pull aborted: another sync holds .sync.lock")
        sys.exit(1)
    try:
        if is_working_tree_dirty():
            print("[!] 工作树有未提交的 memory 变更；请先提交或处理后重跑 pull，避免被覆盖")
            write_marker(".sync-failed", "pull aborted: working tree has uncommitted memory changes")
            sys.exit(1)
        if not fetch_and_merge():
            remote = ls_remote()
            restore_tracking_ref(remote)
            print("[!] 对齐失败：请手动语义合并后重跑，或检查远端状态")
            write_marker(".sync-failed", "pull failed: fetch+merge 对齐失败")
            sys.exit(1)
        if not memory_dir_healthy():
            print("[!] merge 后 memory 目录缺少 memory/index.json 声明的必需文件或文件为空（远端可能异常），终止")
            write_marker(".sync-failed", "pull aborted: merged memory dir missing required files per memory/index.json")
            sys.exit(1)
        ok, local, remote = confirm_no_divergence()
        restore_tracking_ref(remote)
        print("[核验] 本地=%s 远端=%s" % (local, remote))
        if ok:
            print("对齐 ✓")
            clear_marker(".sync-failed")
        else:
            print("分叉 ⚠️（本地与远端不在同一祖先链）")
            write_marker(".sync-failed", "pull 后本地与远端分叉")
            sys.exit(1)
    finally:
        release_lock()


def cmd_push():
    print("== 收尾推送 ==")
    ensure_git_safe()
    cleanup_stale_backups()
    if not memory_dir_healthy():
        print("[!] memory 目录缺少 memory/index.json 声明的必需文件或文件为空（删除传播护栏），终止 push")
        write_marker(".sync-failed", "push aborted: missing/empty required files per memory/index.json")
        sys.exit(1)
    leak = find_secret_leak(os.path.join(REPO, "memory"))
    if leak:
        print("[!] 检测到疑似密钥/令牌（secret-like value）于 memory/%s，拒绝 push 以防泄露" % leak)
        write_marker(".sync-failed", "push aborted: secret-like value in memory/%s" % leak)
        sys.exit(1)
    if not proxy_alive() and PROXY:
        print("[!] 代理 %s 不可达（Clash 未启动？），终止以免 git 卡死" % PROXY)
        write_marker(".sync-failed", "push aborted: proxy %s unreachable" % PROXY)
        sys.exit(1)
    if not acquire_lock():
        print("[!] 已有另一同步进程持锁，拒绝并发 push")
        write_marker(".sync-failed", "push aborted: another sync holds .sync.lock")
        sys.exit(1)
    try:
        if is_working_tree_dirty():
            print("[!] 工作树有未提交的 memory 变更；请先 commit，否则 push 只会上传旧 HEAD")
            write_marker(".sync-failed", "push aborted: working tree has uncommitted memory changes")
            sys.exit(1)
        # 先 fetch 对齐，避免并发非快进失败（P10）
        if not fetch_and_merge():
            print("[!] 对齐失败，终止 push（避免覆盖远端）")
            write_marker(".sync-failed", "push aborted: fetch+merge 对齐失败")
            sys.exit(1)
        code, out, err = git("push", "origin", "main")
        print("[push] exit=%d" % code)
        if out:
            print(out)
        if err:
            print(redact(err))
        if code != 0:
            # push 被拒（并发远端又前进）：重新 fetch+merge 后重推一轮
            print("[!] push 被拒，重新 fetch+merge 后重推")
            if not fetch_and_merge():
                print("[!] 二次对齐失败，终止")
                write_marker(".sync-failed", "push failed: 二次对齐失败")
                sys.exit(1)
            code, out, err = git("push", "origin", "main")
            print("[push 重试] exit=%d" % code)
            if out:
                print(out)
            if err:
                print(redact(err))
        ok, local, remote = confirm_no_divergence()
        restore_tracking_ref(remote)
        print("[核验] 本地=%s 远端=%s" % (local, remote))
        if ok:
            print("已推送 ✓")
            clear_marker(".sync-failed")
            sys.exit(0)
        print("未推上远端 ⚠️（本地与远端分叉；沙盒内 push 可能未落盘，非沙盒重试）")
        write_marker(".sync-failed", "push 后本地与远端分叉")
        sys.exit(1)
    finally:
        release_lock()


def check_ref_valid(remote=None):
    """校验 tracking ref 是否与远端 main 一致（消假阳：比对 ls-remote 哈希，而非仅验 40-hex）。

    原实现只验 40-hex 正则，ref 悬空/指向错误提交时仍 PASS，会主动掩盖本地落后于远端的漂移。
    现改为与远端真实哈希比对；远端不可达时视为 FAIL（不作通过）。
    """
    if remote is None:
        remote = ls_remote()
    if not remote:
        return False, "远端不可达，无法比对（不作通过）"
    ref_path = os.path.join(REPO, ".git", "refs", "remotes", "origin", "main")
    if not os.path.exists(ref_path):
        return False, "丢失（沙盒 overlay 所致，pull/push 模式会自动补写）"
    try:
        with open(ref_path, "r", encoding="ascii") as f:
            content = f.read().strip()
    except Exception as e:
        return False, "读取失败: %s" % e
    if not re.fullmatch(r"[0-9a-f]{40}", content):
        return False, "非法内容: %r" % content[:40]
    if content != remote:
        return False, "漂移：ref=%s ≠ 远端=%s" % (content[:12], remote[:12])
    return True, content[:12]


def cmd_doctor():
    print("== 体检 ==")
    cleanup_stale_backups()
    failures = []

    def report(name, ok, detail=""):
        print("[%s] %s%s" % (
            "PASS" if ok else "FAIL", name,
            ("（%s）" % detail if detail else "")))
        if not ok:
            failures.append(name)

    code, out, _ = git("--version", proxy=False)
    print("[git] %s" % out)
    print("[git 路径] %s" % GIT)
    report("git client safe (not PortableGit)", git_is_safe(), GIT)
    print("[代理 %s] %s" % (redact(PROXY), "可达" if proxy_alive() else "不可达（Clash 未启动？）"))
    code, helper_out, _ = git("config", "--get-all", "credential.helper", proxy=False)
    helper_out = helper_out or ""
    code, url_helper, _ = git("config", "--get", "credential.https://github.com.helper", proxy=False)
    url_helper = url_helper or ""
    print("[credential.helper] %s" % redact(helper_out or "(unset)"))
    if url_helper:
        print("[credential.https://github.com.helper] %s" % redact(url_helper))
    if "gh" not in (helper_out + " " + url_helper).lower():
        print("[WARN] 未检测到 gh 凭据助手（当前 helper：%s）；README 建议 gh auth login 生成 git credential helper，避免长期令牌 setx 常驻" % redact(helper_out or "(unset)"))
    for var in ("GITHUB_PAT_TOKEN", "GH_TOKEN"):
        if os.environ.get(var):
            print("[WARN] 检测到长期令牌环境变量 %s；建议改用 gh auth login + git credential helper" % var)
    remote = ls_remote()
    local = local_head()
    print("[远端] %s" % remote)
    print("[本地] %s" % local)
    report("remote reachable", bool(remote), remote or "")
    report("local head readable", bool(local), local or "")
    ok, detail = check_ref_valid(remote)
    report("tracking ref valid", ok, detail)
    for marker in (".sync-failed", ".pending-writeback"):
        p = os.path.join(REPO, marker)
        exists = os.path.exists(p)
        report("no stale %s" % marker, not exists,
               "有残留!" if exists else "无")
    # union 配置检查（P1/P6）
    code, out, _ = git("config", "--get", "merge.union.driver", proxy=False)
    union_ok = code == 0 and "git merge-file --union" in out
    report("merge.union.driver configured", union_ok,
           out if code == 0 else "未配置（归档.md 自动合并会失效）")
    code, out, _ = git("check-attr", "merge", "--", "memory/归档.md", proxy=False)
    report("归档.md merge=union", code == 0 and "union" in out, out or "(无)")

    code, out, _ = git("config", "--get", "core.autocrlf", proxy=False)
    crlf_ok = code != 0 or out.strip() in ("", "false")
    report("core.autocrlf=false", crlf_ok, out.strip() if code == 0 else "(unset)")

    ga_path = os.path.join(REPO, ".gitattributes")
    ga_text = ""
    if os.path.exists(ga_path):
        with open(ga_path, "r", encoding="utf-8") as f:
            ga_text = f.read()
    report(".gitattributes eol=lf", "eol=lf" in ga_text)

    # 本地协议新鲜度：WorkBuddy 侧 MEMORY.md 不得残留已废弃的 pull --rebase 指令
    # （2026-08-16 三轮审计 P0：此脱节曾让 doctor 全绿却仍执行 rebase）。
    wb_memory_md = os.path.expanduser("~/.workbuddy/MEMORY.md")
    if os.path.isfile(wb_memory_md):
        try:
            with open(wb_memory_md, "r", encoding="utf-8") as f:
                wb_protocol = f.read()
        except Exception:
            wb_protocol = ""
        report("MEMORY.md 无已废弃 pull --rebase 指令",
               "pull --rebase" not in wb_protocol)

    dirty = git_status_memory()
    report("working tree clean", dirty == [],
           "" if dirty is None else ("clean" if dirty == [] else "有未提交变更"))
    report("memory dir healthy (files per memory/index.json)", memory_dir_healthy())
    # 版本对齐阻挡态：本地落后远端时必须显式标红并指引 re-pull（doctor 不再静默放行）
    if local and remote:
        if local == remote:
            report("local == remote", True, "一致")
        else:
            git("fetch", "origin", "main")  # 确保远端对象在本地，merge-base 才能判定方向
            code, _, _ = git("merge-base", "--is-ancestor", local, remote, proxy=False)
            if code == 0:
                report("local == remote", False,
                       "本地落后远端（%s..%s），读前必须 re-pull，否则结论不可信" % (local[:12], remote[:12]))
            else:
                report("local == remote", False, "本地与远端分叉，需手动语义合并")
    else:
        report("local == remote", False, "无法判定（本地或远端不可读）")

    code, out, _ = git("status", "--porcelain", proxy=False)
    all_dirty = [l for l in (out or "").splitlines() if l.strip()]
    print("[info] 全仓未提交变更 %d 项（含脚本/文档，需自行 commit）" % len(all_dirty))

    archive_path = os.path.join(REPO, "memory", "归档.md")
    if os.path.isfile(archive_path):
        size = os.path.getsize(archive_path)
        try:
            with open(archive_path, "r", encoding="utf-8") as f:
                lines = sum(1 for _ in f)
        except Exception:
            lines = 0
        if size > 120000 or lines > 1200:
            print("[提示] 归档.md 已超瘦身阈值（%d bytes / %d 行），建议压缩为结论 + 唯一事实"
                  % (size, lines))

    if failures:
        print("doctor: %d FAILURE(S)" % len(failures))
        sys.exit(1)
    print("doctor: ALL PASS")
    sys.exit(0)


def cmd_bootstrap():
    print("== 一次性接入配置（bootstrap） ==")
    ensure_git_safe()
    settings = {
        "core.autocrlf": "false",
        "merge.union.driver": "git merge-file --union %A %O %B",
        "maintenance.auto": "false",
        "gc.auto": "0",
        "gc.pruneExpire": "never",
        "fetch.autoMaintenance": "false",
    }
    for k, v in settings.items():
        code, out, err = git("config", k, v, proxy=False)
        print("[config] %s=%s -> %s" % (k, v, "OK" if code == 0 else ("FAIL: " + err)))
    print("bootstrap 完成；再跑 doctor 自检")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "doctor"
    access = sys.argv[2] if len(sys.argv) > 2 else ""
    if mode == "pull":
        cmd_pull(access)
    elif mode == "push":
        cmd_push()
    elif mode == "doctor":
        cmd_doctor()
    elif mode == "bootstrap":
        cmd_bootstrap()
    else:
        cmd_doctor()


if __name__ == "__main__":
    main()
