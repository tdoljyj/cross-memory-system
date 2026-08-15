#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 侧记忆同步脚本（Python 版）

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
"""

import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from datetime import datetime

REPO = os.path.expanduser("~/.workbuddy/codex-memory-system")
PROXY = "http://127.0.0.1:7897"  # 本机 Clash 代理；无代理时设为 ""
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 7897

# git 优先级：官方 Git for Windows（真非沙盒下健康）> PortableGit（PATH 兜底）
GIT_CANDIDATES = [
    "C:/Program Files/Git/bin/git.exe",
    "C:/Program Files/Git/cmd/git.exe",
]


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
        print("[!] ls-remote 失败: %s" % err)
        return None
    if not out.strip():
        print("[!] ls-remote 空输出（远端可能无 main 分支）")
        return None
    return out.split()[0]


def local_head():
    code, out, _ = git("rev-parse", "HEAD", proxy=False)
    return out if code == 0 else None


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
                datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message))
    except Exception as e:
        print("[!] 写 %s 失败: %s" % (name, e))


def clear_marker(name):
    try:
        if os.path.exists(marker_path(name)):
            os.remove(marker_path(name))
    except Exception as e:
        print("[!] 清除 %s 失败: %s" % (name, e))


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
        print(err)
    if code != 0:
        print("[!] merge 冲突（code=%d），执行 --abort 清理中间态" % code)
        snap = backup_conflict()
        if snap:
            print("[conflict-snapshot] %s" % snap)
        git("merge", "--abort", proxy=False)
        return False
    return True


def cmd_pull():
    print("== 开场拉取对齐 ==")
    ensure_git_safe()
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
    remote = ls_remote()
    restore_tracking_ref(remote)
    local = local_head()
    print("[核验] 本地=%s 远端=%s" % (local, remote))
    if local == remote:
        print("一致 ✓")
        clear_marker(".sync-failed")
    else:
        print("不一致 ⚠️（注意分叉）")
        write_marker(".sync-failed", "pull 后本地与远端不一致")
        sys.exit(1)


def cmd_push():
    print("== 收尾推送 ==")
    ensure_git_safe()
    if is_working_tree_dirty():
        print("[!] 工作树有未提交的 memory 变更；请先 commit，否则 push 只会上传旧 HEAD")
        write_marker(".sync-failed", "push aborted: working tree has uncommitted memory changes")
        sys.exit(1)
    if not proxy_alive() and PROXY:
        print("[!] 代理 %s 不可达（Clash 未启动？），终止以免 git 卡死" % PROXY)
        write_marker(".sync-failed", "push aborted: proxy %s unreachable" % PROXY)
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
        print(err)
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
            print(err)
    remote = ls_remote()
    local = local_head()
    restore_tracking_ref(remote)
    print("[核验] 本地=%s 远端=%s" % (local, remote))
    if local == remote:
        print("已推送 ✓")
        clear_marker(".sync-failed")
        sys.exit(0)
    print("未推上远端 ⚠️（沙盒内 push 可能未落盘，非沙盒重试）")
    write_marker(".sync-failed", "push 后本地与远端不一致")
    sys.exit(1)


def check_ref_valid():
    """校验 tracking ref 文件内容是否为合法 40 位 hex（P4）。"""
    ref_path = os.path.join(REPO, ".git", "refs", "remotes", "origin", "main")
    if not os.path.exists(ref_path):
        return False, "丢失（沙盒 overlay 所致，pull/push 模式会自动补写）"
    try:
        with open(ref_path, "r", encoding="ascii") as f:
            content = f.read().strip()
    except Exception as e:
        return False, "读取失败: %s" % e
    if re.fullmatch(r"[0-9a-f]{40}", content):
        return True, content[:12]
    return False, "非法内容: %r" % content[:40]


def cmd_doctor():
    print("== 体检 ==")
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
    print("[代理 %s] %s" % (PROXY, "可达" if proxy_alive() else "不可达（Clash 未启动？）"))
    remote = ls_remote()
    local = local_head()
    print("[远端] %s" % remote)
    print("[本地] %s" % local)
    report("remote reachable", bool(remote), remote or "")
    report("local head readable", bool(local), local or "")
    ok, detail = check_ref_valid()
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

    dirty = git_status_memory()
    report("working tree clean", dirty == [],
           "" if dirty is None else ("clean" if dirty == [] else "有未提交变更"))
    report("local == remote", bool(local and remote and local == remote))

    if failures:
        print("doctor: %d FAILURE(S)" % len(failures))
        sys.exit(1)
    print("doctor: ALL PASS")
    sys.exit(0)


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "doctor"
    {"pull": cmd_pull, "push": cmd_push, "doctor": cmd_doctor}.get(mode, cmd_doctor)()


if __name__ == "__main__":
    main()
