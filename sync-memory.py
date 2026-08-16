#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 侧记忆同步脚本（Python 版）

模块定位（对齐《架构基线文档-vNext-1.3.md》vNext-1.3）：本脚本 = WorkBuddy 端 AI Adapter
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
from urllib.parse import urlparse

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


def _env_proxy():
    for var in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        v = os.environ.get(var)
        if v:
            return v
    return None


def _proxy_host_port(url):
    try:
        p = urlparse(url)
        return p.hostname or "127.0.0.1", p.port or 7897
    except Exception:
        return "127.0.0.1", 7897


# 代理优先级：config > 环境变量(HTTPS_PROXY/HTTP_PROXY) > 默认。环境变量优先于默认，
# 解决 C11：环境真实代理 7892 与硬编码 7897 不一致导致的 fail-closed 永久误杀。
PROXY = _CONFIG.get("proxy") or _env_proxy() or "http://127.0.0.1:7897"  # 无代理时设为 ""
PROXY_HOST, PROXY_PORT = _proxy_host_port(PROXY)

# 缺省 REPO = 脚本所在克隆根目录（fail-safe）：sync.config.json 是 gitignored 文件、
# 新克隆天然缺失；原缺省回落 ~/.workbuddy/codex-memory-system 会把无配置运行指向
# WorkBuddy 端克隆（fail-open 越界默认，P0-2）。config 的 repo 仅作显式覆盖。
REPO = os.path.expanduser(
    _CONFIG.get("repo") or os.path.dirname(os.path.abspath(__file__)))

# 消费端操作记忆协议文件（本端自检对象，per-clone 参数化）：
# WorkBuddy 端默认 ~/.workbuddy/MEMORY.md；DSH 端经 sync.config.json 的
# consumer_memory_path 指向 ~/.dsh/MEMORY.md。doctor 的协议新鲜度与
# conform 触发式禁令探针均只检本端该文件（不越界互检）。
CONSUMER_MEMORY_PATH = os.path.expanduser(
    _CONFIG.get("consumer_memory_path", "~/.workbuddy/MEMORY.md"))

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


def direct_reachable():
    """直连 github.com 可达性探测（措施12 直连兜底）。"""
    try:
        with socket.create_connection(("github.com", 443), timeout=3.0):
            return True
    except Exception:
        return False


def resolve_network():
    """措施12：代理可达→走代理；代理不可达但直连可达→清空 PROXY 走直连；
    都不可达→返回 False。调用方据此决定是否继续（消 C11 的 fail-closed 永久误杀）。
    """
    global PROXY
    if not PROXY:
        return True
    if proxy_alive():
        return True
    if direct_reachable():
        print("[代理] 代理 %s 不可达，但直连可达，本次改用直连" % PROXY)
        PROXY = ""
        return True
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
    if proxy:
        # GAP-3-6：lowSpeed 超时与 ps1 对齐（HTTP 传输半死时不再耗满 60s 总超时）
        cmd += ["-c", "http.lowSpeedLimit=1", "-c", "http.lowSpeedTime=15"]
        if PROXY:
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
    if not files:
        return None
    # GAP-3-10：路径净化——files 项必须是 memory 目录内的 .md 基名，
    # 含目录分隔符/相对路径/非 .md 后缀一律按索引非法 fail-closed（防 ../ 逃逸）。
    for f in files:
        if (not f.endswith(".md") or os.path.basename(f) != f
                or "/" in f or "\\" in f):
            return None
    return files


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


def index_recall_valid():
    """校验 memory/index.json 的 recall 段名在对应 .md 中真实存在（标题改写会静默失效）。
    返回 (ok, detail)。"""
    idx = load_index()
    if not idx or not isinstance(idx.get("recall"), dict):
        return False, "index.json 缺失或 recall 不可解析"
    bad = []
    for key, entries in idx.get("recall", {}).items():
        for entry in entries or []:
            f = entry.get("file")
            p = os.path.join(REPO, "memory", f)
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    text = fh.read()
            except Exception:
                bad.append("%s %s 不可读" % (key, f))
                continue
            for sec in entry.get("sections") or []:
                if sec and ("## " + sec) not in text:
                    bad.append("%s %s「%s」" % (key, f, sec))
    return (len(bad) == 0), ("; ".join(bad))


_TOKEN_RE = re.compile(
    r"(?i)(bearer\s+)[A-Za-z0-9._-]+"
    r"|gho_[A-Za-z0-9]+"
    r"|ghp_[A-Za-z0-9]+"
    r"|github_pat_[A-Za-z0-9_]+"
    r"|AKIA[0-9A-Z]{16}"
    r"|-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"
)


def redact(text):
    """掩码凭据样值（覆盖 guards.json 全部模式：gho_/ghp_/github_pat_/AKIA/私钥头/Bearer），
    不落到输出或 .sync-failed。"""
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
        if token.startswith("AKIA"):
            return "AKIA***"
        if token.startswith("-----BEGIN"):
            # 掩码输出刻意不含「-----BEGIN ... PRIVATE KEY-----」字面（防自命中扫描模式）
            return "-----BEGIN PRIVATE KEY HEADER-----"
        return token

    return _TOKEN_RE.sub(mask, text)


_GUARDS_PATH = os.path.join(REPO, "guards.json")
_GUARDS = None


def load_guards():
    """读 guards.json（护栏契约单一事实源，措施9）。失败回落 {}，调用方回落内置默认。"""
    global _GUARDS
    if _GUARDS is not None:
        return _GUARDS
    try:
        with open(_GUARDS_PATH, "r", encoding="utf-8") as f:
            _GUARDS = json.load(f)
    except Exception:
        _GUARDS = {}
    return _GUARDS


_SECRET_PATTERNS = (load_guards().get("secret_patterns") or [
    r"gh[op]_[A-Za-z0-9]{20,}",
    r"github_pat_[A-Za-z0-9_]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
    r"(?i)bearer\s+[A-Za-z0-9._-]{20,}",
])


def _lock_path():
    return os.path.join(REPO, ".sync.lock")


def _pid_alive(pid):
    """锁持有者探活。Windows 下 os.kill(pid, 0) 会被 CPython 映射为
    TerminateProcess(pid, 0)（强制终止，sig 即退出码），不是 liveness 探测——
    持锁并发时会把另一个同步进程杀死，PID 复用后还会误杀无关进程（P1-1 修复）。
    Windows 改用 OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) + GetExitCodeProcess：
    打开失败=进程不存在；ERROR_ACCESS_DENIED(5)=无权打开但进程存在，按存活保守处理。"""
    if not pid or pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            STILL_ACTIVE = 259
            handle = kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                # 5 = ERROR_ACCESS_DENIED：进程存在但无权查询 → 保守按存活
                return ctypes.get_last_error() == 5
            try:
                code = ctypes.c_ulong()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True  # 查询失败 → 保守按存活，防锁被偷
                return code.value == STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True  # 探活机制自身异常 → 保守按存活
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


def find_secret_leak_staged():
    """扫 git diff --cached（staged）的 index blob 内容（`git show :<path>`），覆盖全仓提交路径。

    与 find_secret_leak（只扫 memory/*.md）互补，防令牌经全仓提交（ps1 -CommitRepo
    等价路径）进入 git 历史。读 index blob 而非工作树文件：stage 令牌后工作树回改的
    TOCTOU 场景下，工作树读取会漏检（P2-1；与 sync-memory.ps1 Find-SecretLeakStaged
    语义统一）。staged 为空时返回 None（无可扫描内容，不算失败）。
    """
    code, out, _ = git("diff", "--cached", "--name-only", "-z", proxy=False)
    if code != 0 or not out.strip():
        return None
    for name in out.split("\0"):
        if not name:
            continue
        c, blob, _ = git("show", ":%s" % name, proxy=False)
        if c != 0:
            continue
        for pat in _SECRET_PATTERNS:
            if re.search(pat, blob):
                return name
    return None


def find_secret_leak_unpushed():
    """扫本地领先远端的提交内容（origin/main..HEAD 的文件级 diff，读 HEAD blob），
    覆盖已 commit 但未推送的脚本/文档等非 memory 文件（P2-2）。

    py 端 commit 由使用方执行，push 时 staged 常为空，仅靠 staged 扫描会漏掉
    已入库令牌。远端不可达 / 无领先 / git 失败时返回 None（由 push 主流程的
    对齐与核验步骤兜底）。
    """
    remote = ls_remote()
    if not remote:
        return None
    code, out, _ = git("diff", "--name-only", "-z", "%s..HEAD" % remote, proxy=False)
    if code != 0 or not out.strip():
        return None
    for name in out.split("\0"):
        if not name:
            continue
        c, blob, _ = git("show", "HEAD:%s" % name, proxy=False)
        if c != 0:
            continue
        for pat in _SECRET_PATTERNS:
            if re.search(pat, blob):
                return name
    return None


def is_ancestor(a, b):
    """a 是否是 b 的祖先（merge-base --is-ancestor）。"""
    code, _, _ = git("merge-base", "--is-ancestor", a, b, proxy=False)
    return code == 0


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
    code, _, _ = git("merge-base", "--is-ancestor", local, remote, proxy=False)
    if code >= 128:
        # 远端对象不在本地才 fetch（GAP-3-6：消 pull/push 路径的二次 fetch；
        # merge-base 对 --is-ancestor 的 0/1 已是确定结论，128 才是对象缺失/错误）
        git("fetch", "origin", "main")
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


SNAPSHOT_DIR = os.path.join(REPO, ".conflict-snapshots")


def cleanup_stale_backups(retention_days=None):
    """清理过期的临时备份目录（只增不减的历史债务）。

    保留期默认取 guards.json（护栏契约单一事实源），缺省回落 2 天。
    措施11：冲突快照改写仓库内 .conflict-snapshots/（私有、gitignored），
    与 %TEMP% 遗留备份统一按保留期清理。
    """
    if retention_days is None:
        # 回落默认与 guards.json 一致（7 天，GAP-2-1 机器口径统一）；
        # guards.json 缺失时不得回落为 2 天旧口径。
        retention_days = load_guards().get("backup_retention_days", 7)
    cutoff = time.time() - retention_days * 86400
    for base in (tempfile.gettempdir(), SNAPSHOT_DIR):
        try:
            for name in os.listdir(base):
                if not name.startswith("codex-memory-"):
                    continue
                p = os.path.join(base, name)
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
    # 措施11：冲突快照（base/ours/theirs 三阶段 + 冲突文件）写仓库内 gitignored
    # .conflict-snapshots/，不落 %TEMP%（对同用户所有进程可读，隐私暴露面大）。
    dest = os.path.join(
        SNAPSHOT_DIR,
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


def object_exists(h):
    """校验对象是否真在本地对象库（rev-parse 不做此校验，可能返回悬空 ref 的 hash）。"""
    if not h:
        return False
    code, _, _ = git("cat-file", "-e", "%s^{commit}" % h, proxy=False)
    return code == 0


def restore_tracking_ref(remote):
    """补写 refs/remotes/origin/main，让 git status 干净。写前校验对象存在，防悬空 ref。"""
    if not remote:
        return False
    if not object_exists(remote):
        print("[ref] 跳过补写：远端对象 %s 不在本地，写入会产生悬空 ref" % remote[:12])
        return False
    ok = write_ref("refs/remotes/origin/main", remote)
    print("[ref] 补写 refs/remotes/origin/main = %s  %s"
          % (remote[:12], "OK" if ok else "FAIL"))
    return ok


def fetch_and_merge():
    """fetch 后 merge FETCH_HEAD（非 rebase）。返回是否成功对齐。"""
    code, out, err = git("fetch", "origin", "main")
    print("[fetch] %s" % ("OK" if code == 0 else "FAIL: " + redact(err)))
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
    # Access=NONE 必须是纯短路：在任何写副作用（git 安全护栏标记 / TEMP 清理）之前返回
    if access.strip().upper() == "NONE":
        print("Memory Access = NONE; 按需读取判定为无关，跳过 pull")
        return
    ensure_git_safe()
    cleanup_stale_backups()
    if not resolve_network():
        print("[!] 代理 %s 不可达且直连失败（Clash 未启动？），终止以免 git 卡死" % PROXY)
        write_marker(".sync-failed", "pull aborted: proxy %s unreachable" % PROXY)
        sys.exit(1)
    if load_index() is None:
        print("[!] memory/index.json 缺失或非法（护栏唯一事实源不可用），终止 pull")
        write_marker(".sync-failed", "pull aborted: memory/index.json missing or invalid")
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
        elif local and remote and is_ancestor(remote, local):
            # 本地领先远端：上次 push 失败留下的已提交记忆。pull=读，不再内嵌 push
            # （措施8：读路径不得有写副作用，沙盒内 push 会假成功）。只报告并写
            # .needs-push 标记，由使用方在非沙盒显式 push（对齐 AGENTS:72）。
            print("[领先] 本地领先远端（有未推送的已提交记忆），pull=读不在此 push")
            write_marker(".needs-push", "本地领先远端，待非沙盒显式 push（sync-memory.py push）")
            clear_marker(".sync-failed")
            print("提示：在非沙盒环境运行 sync-memory.py push 补齐推送")
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
    if load_index() is None:
        print("[!] memory/index.json 缺失或非法（护栏唯一事实源不可用），终止 push")
        write_marker(".sync-failed", "push aborted: memory/index.json missing or invalid")
        sys.exit(1)
    if not memory_dir_healthy():
        print("[!] memory 目录缺少 memory/index.json 声明的必需文件或文件为空（删除传播护栏），终止 push")
        write_marker(".sync-failed", "push aborted: missing/empty required files per memory/index.json")
        sys.exit(1)
    leak = find_secret_leak(os.path.join(REPO, "memory"))
    if leak:
        print("[!] 检测到疑似密钥/令牌（secret-like value）于 memory/%s，拒绝 push 以防泄露" % leak)
        write_marker(".sync-failed", "push aborted: secret-like value in memory/%s" % leak)
        sys.exit(1)
    leak = find_secret_leak_staged()
    if leak:
        print("[!] 检测到疑似密钥/令牌（secret-like value）于 staged %s，拒绝 push 以防泄露" % leak)
        write_marker(".sync-failed", "push aborted: secret-like value in staged %s" % leak)
        sys.exit(1)
    if not resolve_network():
        print("[!] 代理 %s 不可达且直连失败（Clash 未启动？），终止以免 git 卡死" % PROXY)
        write_marker(".sync-failed", "push aborted: proxy %s unreachable" % PROXY)
        sys.exit(1)
    leak = find_secret_leak_unpushed()
    if leak:
        print("[!] 检测到疑似密钥/令牌（secret-like value）于未推送提交 %s，拒绝 push 以防泄露" % leak)
        write_marker(".sync-failed", "push aborted: secret-like value in unpushed %s" % leak)
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
            clear_marker(".needs-push")  # P1-3：push 成功后清除领先标记，生命周期闭环
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
    if not object_exists(content):
        return False, "悬空 ref：对象 %s 不在本地对象库" % content[:12]
    if content != remote:
        return False, "漂移：ref=%s ≠ 远端=%s" % (content[:12], remote[:12])
    return True, content[:12]


# 消费端操作记忆 conform 探针（残留边界收窄，vNext-1.3 残留边界收窄）：
# 须同时声明「版本真值核对」+「触发式」+「禁自动化」三要素，才视为已对齐
# vNext-1.3 显式化加固。语义匹配（非硬编码版本号），版本号一致性由
# check_ref_valid / local==remote 阻挡态管。doctor 据此把「被动未 conform」
# 从静默失效转为可检测红旗。
CONFORM_MARKERS = ("版本真值核对", "触发式", "禁自动化")

# 语义反转否决词：marker 被这些词修饰（"不执行版本真值核对"/"触发式加载已废除"）
# 时视为未 conform——三词齐全但语义相反不得通过（2026-08-16 审计 C5）。
_NEGATION_WORDS = ("不执行", "不启用", "已废除", "废除", "作废", "取消", "停止", "移除", "不再", "无需")
_NEGATION_WINDOW = 16


def consumer_conformed(text):
    """消费端操作记忆（MEMORY.md / Codex AGENTS.md）是否声明了触发式禁令。

    判据：① 三要素「版本真值核对/触发式/禁自动化」齐全；② 任一否定词前后窗口内
    不得出现三要素（防语义反转：声明与否定并存视为未 conform）。
    """
    if not text:
        return False
    for m in CONFORM_MARKERS:
        if m not in text:
            return False
    for neg in _NEGATION_WORDS:
        i = text.find(neg)
        while i != -1:
            window = text[max(0, i - _NEGATION_WINDOW):i + len(neg) + _NEGATION_WINDOW]
            if any(m in window for m in CONFORM_MARKERS):
                return False
            i = text.find(neg, i + 1)
    return True


def consumer_conformed_file(path):
    """fail-closed 版探针：消费记忆文件缺失/不可读即 False（与 memory_dir_healthy 纪律一致）。

    2026-08-16 审计 C5：原实现文件缺失时整段跳过（fail-open），"删掉被检查对象"
    成为绕过检查的最简路径；此处反转，缺失 = FAIL。
    """
    if not path or not os.path.isfile(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return False
    return consumer_conformed(text)


def cmd_doctor():
    print("== 体检 ==")
    cleanup_stale_backups()
    failures = []

    if not load_guards():
        print("[WARN] guards.json 缺失或不可解析：护栏契约回落内置默认（密钥模式/保留期 7 天）；请从远端恢复该文件防口径漂移（GAP-3-4）")

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
    code, name_out, _ = git("config", "--get", "user.name", proxy=False)
    print("[git 身份] %s" % (name_out or "(未设置)"))
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
    if not ok and remote:
        # 自愈前置（沙盒 overlay 常态）：tracking ref 丢失/漂移先自动补写，
        # 补写成功报 AUTO-HEALED 不计失败；仅真分叉/补写失败才 FAIL 阻断。
        if restore_tracking_ref(remote):
            ok, detail = check_ref_valid(remote)
            if ok:
                report("tracking ref valid", True,
                       "AUTO-HEALED（补写 refs/remotes/origin/main=%s）" % remote[:12])
            else:
                report("tracking ref valid", False, "自愈补写后仍失败: %s" % detail)
        else:
            report("tracking ref valid", False, detail)
    else:
        report("tracking ref valid", ok, detail)
    # GAP-2-3（对齐 ps1 -Doctor）：ref 写入持久性行为探针（update-ref 写入→读回→删除）。
    # 沙盒 overlay 拦截两层 ref 原子写时在此暴露，而非静默漂移。
    if local:
        test_ref = "refs/remotes/origin/doctor-test"
        c1, _, _ = git("update-ref", test_ref, local, proxy=False)
        c2, read_back, _ = git("rev-parse", test_ref, proxy=False)
        git("update-ref", "-d", test_ref, proxy=False)
        report("ref write persists (behavior probe)", c1 == 0 and c2 == 0 and read_back == local,
               "read back: %s" % (read_back[:12] if read_back else "(empty)"))
    else:
        report("ref write persists (behavior probe)", False, "本地 HEAD 不可读")

    for marker in (".sync-failed", ".pending-writeback"):
        p = os.path.join(REPO, marker)
        exists = os.path.exists(p)
        report("no stale %s" % marker, not exists,
               "有残留!" if exists else "无")
    if os.path.exists(os.path.join(REPO, ".needs-push")):
        print("[info] .needs-push 存在：本地有未推送的已提交记忆，需显式 push（不视为失败）")
    lockp = os.path.join(REPO, ".sync.lock")
    if os.path.exists(lockp):
        print("[info] .sync.lock 存在：持有进程已退出时下次同步自动清理；PID 复用可能楔住时手工删除 .sync.lock 解除（GAP-3-5）")
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

    # 本地协议新鲜度：本端消费端操作记忆不得残留已废弃的 pull --rebase 指令
    # （2026-08-16 三轮审计 P0：此脱节曾让 doctor 全绿却仍执行 rebase）。
    # 消费文件路径 per-clone 参数化（consumer_memory_path），只检本端、不越界互检。
    wb_memory_md = CONSUMER_MEMORY_PATH
    wb_protocol = ""
    if os.path.isfile(wb_memory_md):
        try:
            with open(wb_memory_md, "r", encoding="utf-8") as f:
                wb_protocol = f.read()
        except Exception:
            wb_protocol = ""
    hook_name = os.path.basename(wb_memory_md)
    report("%s 无已废弃 pull --rebase 指令" % hook_name,
           os.path.isfile(wb_memory_md) and "pull --rebase" not in wb_protocol,
           "" if os.path.isfile(wb_memory_md) and "pull --rebase" not in wb_protocol
           else ("文件缺失" if not os.path.isfile(wb_memory_md) else "残留已废弃指令"))
    # 消费端 conform 探针（残留边界收窄，仅检本端消费记忆）：
    # 须声明「版本真值核对/触发式/禁自动化」三要素，否则视为未对齐
    # vNext-1.3 显式化加固。ps1 侧 2026-08-16 起已补等价探针（各端自检本端）。
    conform_ok = consumer_conformed_file(wb_memory_md)
    report("%s 已 conform 触发式禁令" % hook_name,
           conform_ok,
           "" if conform_ok
           else "文件缺失/不可读，或未声明「版本真值核对/触发式/禁自动化」，未对齐 vNext-1.3 显式化加固")

    dirty = git_status_memory()
    report("working tree clean", dirty == [],
           "" if dirty is None else ("clean" if dirty == [] else "有未提交变更"))
    report("memory dir healthy (files per memory/index.json)", memory_dir_healthy())
    recall_ok, recall_detail = index_recall_valid()
    report("index.json recall 段名有效", recall_ok, recall_detail)
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
        "gc.pruneExpire": "2.weeks",
        "fetch.autoMaintenance": "false",
    }
    for k, v in settings.items():
        code, out, err = git("config", k, v, proxy=False)
        print("[config] %s=%s -> %s" % (k, v, "OK" if code == 0 else ("FAIL: " + err)))
    print("bootstrap 完成；再跑 doctor 自检")


def _deploy_guard():
    """镜像位置护栏（对称 sync-memory.ps1 的 deploy-guard，P2-9 落地）：
    拒绝在 Codex 端克隆（路径含 \\.codex\\）内运行本脚本——仓库是共享的，
    本脚本会出现在每个克隆里；在 Codex 克隆误跑会按默认/配置 REPO 操作
    他端镜像，造成跨端污染。各端只用本端克隆。"""
    here = os.path.realpath(os.path.abspath(__file__)).lower()
    if re.search(r"[\\/]\.codex[\\/]", here) or re.search(r"[\\/]\.codex[\\/]", REPO.lower()):
        print("[deploy-guard] refusing to run inside a .codex clone (跨端污染风险)")
        sys.exit(1)


def main():
    _deploy_guard()
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
