#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WorkBuddy 侧记忆同步脚本（Python 版）

背景（2026-08-16 根因实锤）：
    WorkBuddy 沙盒 overlay 拦截 git 的 lockfile+rename 原子写，
    两层 ref（refs/remotes/origin/main）写不进（exit 0 静默失败、还清空父目录）。
    单层 ref（refs/heads/main）正常；Python os.makedirs+open 直写正常（不走 rename）。

策略（根治方向 2 + 3）：
    - git 只负责对象传输（fetch/pull/push），Python 负责 tracking ref 兜底写入
    - 显式 origin main，不依赖 tracking ref
    - 一切以 ls-remote 为准，不信 git status 的 ahead/behind / gone

用法：
    python sync-memory.py pull      # 开场：fetch + 对齐 + 补写 tracking ref + 核验
    python sync-memory.py push      # 收尾：push + 补写 tracking ref + ls-remote 核验
    python sync-memory.py doctor    # 体检：git / 远端 / refs / 残留标记

注意：
    - commit 不在本脚本职责内（由使用方在改完记忆后自行 commit，再跑 push 模式）
    - push 需在非沙盒环境（dangerouslyDisableSandbox）执行，判据=输出尾出现
      "Sandbox bypassed"；沙盒内 push 的对象可能不落真实盘，跑完用 doctor 核验
"""

import os
import subprocess
import sys

REPO = os.path.expanduser("~/.workbuddy/codex-memory-system")
PROXY = "http://127.0.0.1:7897"  # 本机 Clash 代理；无代理时设为 ""

# git 优先级：官方 Git for Windows（真非沙盒下健康）> PortableGit（PATH 兜底）
GIT_CANDIDATES = [
    "C:/Program Files/Git/bin/git.exe",
    "C:/Program Files/Git/cmd/git.exe",
]


def find_git():
    for c in GIT_CANDIDATES:
        if os.path.exists(c):
            return c
    return "git"


GIT = find_git()


def run(cmd, cwd=REPO):
    p = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
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
    with open(full, "w", newline="") as f:
        f.write(refhash + "\n")
    with open(full, "r") as f:
        return f.read().strip() == refhash


def ls_remote():
    code, out, err = git("ls-remote", "origin", "main")
    if code != 0:
        print("[!] ls-remote 失败: %s" % err)
        return None
    return out.split()[0]


def local_head():
    code, out, _ = git("rev-parse", "HEAD", proxy=False)
    return out if code == 0 else None


def restore_tracking_ref(remote):
    """补写 refs/remotes/origin/main，让 git status 干净。"""
    if not remote:
        return False
    ok = write_ref("refs/remotes/origin/main", remote)
    print("[ref] 补写 refs/remotes/origin/main = %s  %s"
          % (remote[:12], "OK" if ok else "FAIL"))
    return ok


def cmd_pull():
    print("== 开场拉取对齐 ==")
    code, out, err = git("fetch", "origin", "main")
    print("[fetch] %s" % ("OK" if code == 0 else "FAIL: " + err))
    code, out, err = git("pull", "--rebase", "origin", "main")
    print("[pull --rebase] exit=%d" % code)
    if out:
        print(out)
    if err:
        print(err)
    remote = ls_remote()
    restore_tracking_ref(remote)
    local = local_head()
    print("[核验] 本地=%s 远端=%s" % (local, remote))
    print("一致 ✓" if local == remote else "不一致 ⚠️（注意分叉）")


def cmd_push():
    print("== 收尾推送 ==")
    code, out, err = git("push", "origin", "main")
    print("[push] exit=%d" % code)
    if out:
        print(out)
    if err:
        print(err)
    remote = ls_remote()
    local = local_head()
    restore_tracking_ref(remote)
    print("[核验] 本地=%s 远端=%s" % (local, remote))
    print("已推送 ✓" if local == remote else "未推上远端 ⚠️（沙盒内 push 可能未落盘，非沙盒重试）")


def cmd_doctor():
    print("== 体检 ==")
    code, out, _ = git("--version", proxy=False)
    print("[git] %s" % out)
    print("[git 路径] %s" % GIT)
    remote = ls_remote()
    local = local_head()
    print("[远端] %s" % remote)
    print("[本地] %s" % local)
    ref_path = os.path.join(REPO, ".git", "refs", "remotes", "origin", "main")
    print("[tracking ref] %s" %
          ("存在" if os.path.exists(ref_path) else "丢失（沙盒 overlay 所致，pull/push 模式会自动补写）"))
    for marker in (".sync-failed", ".pending-writeback"):
        p = os.path.join(REPO, marker)
        print("[%s] %s" % (marker, "有残留!" if os.path.exists(p) else "无"))
    print("[对齐] %s" % ("一致 ✓" if local == remote else "不一致 ⚠️"))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "doctor"
    {"pull": cmd_pull, "push": cmd_push, "doctor": cmd_doctor}.get(mode, cmd_doctor)()


if __name__ == "__main__":
    main()
