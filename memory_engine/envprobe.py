# -*- coding: utf-8 -*-
"""ENV-DEFECT-001/002 隔离检测与测试归因（Gate 1 裁决：仅 probe/诊断/隔离/证据留存）。

- probe：启动时 capability probe，检测
    * refs/remotes/** 下 git update-ref 写 ref 是否落盘（ENV-DEFECT-001）
    * safe-delete 回收站能力（ENV-DEFECT-002）
  全部在**临时克隆**上执行，绝不触碰真实仓库 .git/refs；
- diagnose：输出明确诊断 + 证据（供报告与留存）；
- attribution：测试结果分栏统计（环境失败 vs 逻辑失败），基于已知环境缺陷模式，
  不以环境缺陷为由降低产品逻辑测试门槛（逻辑失败仍按失败计）。

约束：本模块不把 Python 直写 refs/remotes/** 作为正式规避方案；probe 只读/临时。
"""

import json
import os
import shutil
import subprocess
import tempfile


class EnvProbeResult(object):
    def __init__(self, refs_remotes_writable, safe_delete_available, details):
        self.refs_remotes_writable = refs_remotes_writable
        self.safe_delete_available = safe_delete_available
        self.details = details

    def defects(self):
        out = []
        if not self.refs_remotes_writable:
            out.append("ENV-DEFECT-001")
        if not self.safe_delete_available:
            out.append("ENV-DEFECT-002")
        return out

    def to_dict(self):
        return {
            "refs_remotes_writable": self.refs_remotes_writable,
            "safe_delete_available": self.safe_delete_available,
            "defects": self.defects(),
            "details": self.details,
        }


def _run(cmd, cwd=None, timeout=60):
    try:
        p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"


def probe_refs_remotes_write(git="git", workdir=None):
    """在临时克隆上探测 git update-ref refs/remotes/** 是否落盘。

    返回 (writable: bool, detail: str)。临时目录自动清理。
    """
    tmp = workdir or tempfile.mkdtemp(prefix="envprobe-")
    try:
        remote = os.path.join(tmp, "remote.git")
        code, _, err = _run([git, "init", "--bare", "-b", "main", remote])
        if code != 0:
            return None, "git init 失败: %s" % err
        clone = os.path.join(tmp, "clone")
        code, _, err = _run([git, "clone", remote, clone])
        if code != 0:
            return None, "git clone 失败: %s" % err
        code, _, _ = _run([git, "-C", clone, "config", "user.email", "p@p"])
        code, _, _ = _run([git, "-C", clone, "config", "user.name", "probe"])
        with open(os.path.join(clone, "f.txt"), "w") as f:
            f.write("probe")
        code, _, _ = _run([git, "-C", clone, "add", "f.txt"])
        _run([git, "-C", clone, "commit", "-qm", "c1"])
        code, out, _ = _run([git, "-C", clone, "rev-parse", "HEAD"])
        head = out.strip()
        if code != 0 or not head:
            return None, "HEAD 不可读"
        code, _, _ = _run([git, "-C", clone, "update-ref",
                           "refs/remotes/origin/envprobe-test", head])
        rc, out, _ = _run([git, "-C", clone, "rev-parse",
                           "refs/remotes/origin/envprobe-test"])
        # rev-parse 失败（原样回显参数 + rc=128）→ ref 未落盘
        writable = (rc == 0 and out == head)
        detail = ("ref 落盘 OK" if writable
                  else "ref 未落盘（update-ref exit 0 但 rev-parse 失败）")
        _run([git, "-C", clone, "update-ref", "-d", "refs/remotes/origin/envprobe-test"])
        return writable, detail
    finally:
        if workdir is None:
            shutil.rmtree(tmp, ignore_errors=True)


def probe_safe_delete():
    """探测 safe-delete 回收站能力。

    依据：WorkBuddy 注入 NODE_OPTIONS=--require ...genie-safe-delete.cjs，
    该 shim 在沙盒无回收站时输出 SAFE_DELETE_FAIL_CLOSED。本 probe 检查
    是否存在该 shim 环境标记，并在临时目录尝试删除一个探针文件观察结果。
    """
    detail = []
    node_opts = os.environ.get("NODE_OPTIONS", "")
    has_shim = "genie-safe-delete" in node_opts or "safe-delete" in node_opts
    detail.append("NODE_OPTIONS shim: %s" % ("present" if has_shim else "absent"))
    # 行为探针：创建临时文件并删除，观察 stderr 是否含 FAIL_CLOSED
    tmp = tempfile.mkdtemp(prefix="envprobe-del-")
    probe_file = os.path.join(tmp, "probe.tmp")
    with open(probe_file, "w") as f:
        f.write("x")
    try:
        os.remove(probe_file)
        detail.append("os.remove: ok")
        fail_closed_seen = False
    except Exception as e:
        fail_closed_seen = "recycle" in str(e).lower()
        detail.append("os.remove: %s" % e)
    shutil.rmtree(tmp, ignore_errors=True)
    available = not (has_shim and fail_closed_seen)
    return available, "; ".join(detail)


def probe(git="git", workdir=None, with_safe_delete=True):
    """完整 capability probe（启动时调用）。"""
    refs_ok, refs_detail = probe_refs_remotes_write(git=git, workdir=workdir)
    sd_ok, sd_detail = probe_safe_delete() if with_safe_delete else (True, "skipped")
    return EnvProbeResult(
        refs_remotes_writable=bool(refs_ok),
        safe_delete_available=bool(sd_ok),
        details={"refs_remotes": refs_detail, "safe_delete": sd_detail},
    )


def diagnose(result):
    """人类可读诊断 + 证据。"""
    lines = ["== ENV capability probe =="]
    lines.append("- refs/remotes git write : %s (%s)"
                 % ("OK" if result.refs_remotes_writable else "FAIL",
                    result.details.get("refs_remotes")))
    lines.append("- safe-delete recycle-bin: %s (%s)"
                 % ("OK" if result.safe_delete_available else "FAIL",
                    result.details.get("safe_delete")))
    defects = result.defects()
    if defects:
        lines.append("检测到环境缺陷: %s（属环境事实，不构成产品逻辑失败；"
                     "产品逻辑测试仍须全绿）" % ", ".join(defects))
    else:
        lines.append("无已知环境缺陷")
    return "\n".join(lines)


# ---- 测试归因（环境失败 vs 逻辑失败分栏统计） ----
ENV_FAILURE_PATTERNS = (
    # ENV-DEFECT-001 级联：doctor ref 探针 / install 预检
    "ref write persists",
    "refs/remotes",
    # ENV-DEFECT-002 级联：safe-delete 回收站
    "SAFE_DELETE_FAIL_CLOSED",
    "windows-sandbox-recycle-bin-unavailable",
    "runtime_root",
    # install 预检失败（doctor+runtime_root 环境级联）
    "CLD-INSTALL-001",
)


class TestAttributor(object):
    """把测试结果归因：ENV（环境缺陷导致）/ LOGIC（产品逻辑）。

    归因不改变失败事实；逻辑失败必须修，环境失败记录为环境约束。
    """

    def __init__(self, patterns=ENV_FAILURE_PATTERNS):
        self.patterns = patterns

    def attribute(self, name, status, output=""):
        """返回 'ENV' | 'LOGIC' | 'PASS' | 'SKIP'。

        status: PASS/FAIL/SKIP/ERROR；output: 该测试的日志片段。
        """
        if status in ("PASS", "SKIP"):
            return status
        if status == "ERROR":
            return "LOGIC"  # ERROR 视为逻辑/实现问题（脚本崩溃），不归因环境
        low = (output or "").lower()
        if any(p.lower() in low for p in self.patterns):
            return "ENV"
        return "LOGIC"

    def summarize(self, results):
        """results: list[(name, status, output)] → 分栏统计。"""
        stats = {"PASS": 0, "FAIL": 0, "SKIP": 0, "ERROR": 0,
                 "ENV": 0, "LOGIC": 0}
        by_name = {}
        for name, status, output in results:
            attr = self.attribute(name, status, output)
            stats[attr] = stats.get(attr, 0) + 1
            by_name[name] = attr
        return stats, by_name

    def to_json(self, results):
        stats, by_name = self.summarize(results)
        return json.dumps({"stats": stats, "by_name": by_name},
                          ensure_ascii=False, indent=1)
