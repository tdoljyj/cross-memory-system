# -*- coding: utf-8 -*-
"""受控试装执行器（R1 修复：彻底关闭自动重试，2026-08-20 裁决）。

目的：试装必须满足"一次进程调用、一次 install 调用"，且失败不得自动重试。
两个机制：
1. **进程内**：install 调用计数（INSTALL_LIMIT=1），第二次调用直接抛错；
2. **跨进程**：启动 preflight 检测 journal 残留 —— 若上次执行被中断（journal
   未清理），本次**拒绝执行（fail-closed STOP）**，绝不自动重试 install。
   即使宿主（Bash）自动重试第二次进程，第二次也会 STOP 而非继续 install。

附带断言：
- install 后 journal 零残留（R1 修复 controller.py 幂等分支的回归护栏）；
- 输出可核验执行证据（PID、调用计数、时间戳、install 次数）。

边界：本执行器只封装 install 阶段；conformance/enable 等待第二次试装裁决。
真实 Binding 路径不在本模块（调用方传入 state_root）；测试仅在临时 fixture。
"""

import json
import os
import sys
import time

# 子进程运行时（python tools/trial_runner.py）：repo 根入 sys.path
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


class TrialStop(Exception):
    """试装前置/后置条件不满足 → 立即停止（不得自动重试）。"""


class TrialRunner(object):

    INSTALL_LIMIT = 1

    def __init__(self, state_root):
        self.state_root = state_root
        self.install_calls = 0
        self.pid = os.getpid()

    # ---- 前置：journal 残留检测（跨进程防重试） ----
    def preflight(self, binding_id):
        if not os.path.isdir(self.state_root):
            return  # 目录不存在（尚未创建 binding 时）视为干净
        leftovers = [f for f in os.listdir(self.state_root)
                     if f.startswith(".journal-")]
        if leftovers:
            raise TrialStop(
                "journal 残留（%s）：疑似上次执行中断；拒绝执行，"
                "不得自动重试（请先人工审计）" % leftovers)

    # ---- 单次 install ----
    def install_once(self, binding_id, controller_factory):
        self.preflight(binding_id)
        self.install_calls += 1
        if self.install_calls > self.INSTALL_LIMIT:
            raise TrialStop("install 已执行一次（调用计数=%d），禁止重试"
                            % self.install_calls)
        lc = controller_factory()
        result = lc.install(binding_id)
        # 后置：journal 零残留（幂等分支也必须清理）
        leftovers = [f for f in os.listdir(self.state_root)
                     if f.startswith(".journal-")]
        if leftovers:
            raise TrialStop("install 后 journal 残留: %s（R1 修复回归失败）"
                            % leftovers)
        return result

    # ---- 可核验执行证据 ----
    def evidence(self, binding_id, result):
        return {
            "pid": self.pid,
            "install_calls": self.install_calls,
            "install_limit": self.INSTALL_LIMIT,
            "binding_id": binding_id,
            "note": result.get("note"),
            "binding_state": result.get("binding"),
            "truth": result.get("truth"),
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "single_process_single_install": (
                self.install_calls == 1 and self.pid == os.getpid()),
        }


def main(argv):
    if len(argv) != 4 or argv[1] != "install":
        print("用法: python trial_runner.py install <state_root> <binding_id>",
              file=sys.stderr)
        return 2
    _, _action, state_root, binding_id = argv
    from memory_engine.lifecycle_ctl import LifecycleController
    runner = TrialRunner(state_root)
    try:
        result = runner.install_once(
            binding_id, lambda: LifecycleController(state_root=state_root))
    except TrialStop as e:
        print("STOP: %s" % e, file=sys.stderr)
        return 3
    ev = runner.evidence(binding_id, result)
    print(json.dumps(ev, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
