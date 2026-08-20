# -*- coding: utf-8 -*-
"""受控试装独立 Worker 执行通道（ENV-EXEC 资格验证，2026-08-20 裁决）。

背景：宿主 Bash 会中断真实长命令并自动重发调用（ENV-EXEC），连续导致两次试装
失败。本模块提供**不依赖 Bash 自动重试层**的独立 worker 通道：

- caller 只负责"启动 worker + 记录 run_id/PID"并立即返回；
- worker 是独立 Python 进程，完整执行 install 事务（含收尾与 receipt），
  caller 被中断不影响 worker 完成；
- **唯一 run_id**：caller 传入；lock 文件记录 run_id + PID；
- **单 worker**：lock 存在且无 receipt → ALREADY_RUNNING（不启动第二 worker）；
  receipt 已存在 → ALREADY_DONE（返回已有 receipt）；
- **receipt 原子落盘**：tmp + os.replace；含 exit_code、install_calls、pid、
  run_id、binding 状态、journal 计数；
- install 调用总数严格 = 1（TrialRunner.INSTALL_LIMIT + worker 单次）；
- 临时 journal 最终 = 0；binding 状态完整（无半写）；
- 使用后仅清理临时 fixture（测试路径）。

用法（caller）：
  python trial_worker.py --run-id <id> --state-root <root> --binding <bid> --receipt <path>
退出码：0=DONE/ALREADY_DONE；3=ALREADY_RUNNING；4=FAILED（receipt 含原因）。
"""

import argparse
import json
import os
import sys
import time

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from tools.trial_runner import TrialRunner, TrialStop  # noqa: E402

LOCK_NAME = ".trial-run.lock"


class WorkerError(Exception):
    pass


class TrialWorker(object):

    def __init__(self, state_root, run_id):
        self.state_root = state_root
        self.run_id = run_id
        self.pid = os.getpid()
        self.lock_path = os.path.join(state_root, LOCK_NAME)

    # ---- lock（原子创建，O_EXCL） ----
    def _lock_exists(self):
        return os.path.isfile(self.lock_path)

    def _read_lock(self):
        with open(self.lock_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def acquire_lock(self):
        """返回 "NEW" / "ALREADY_RUNNING" / "ALREADY_DONE"。"""
        os.makedirs(self.state_root, exist_ok=True)
        if self._lock_exists():
            lock = self._read_lock()
            if lock.get("done"):
                if lock.get("run_id") == self.run_id:
                    # 同 run_id 已完成 → 返回已有 receipt
                    return "ALREADY_DONE"
                # 旧 run 已完成（不同 run_id）→ 允许新 run：清除旧 lock
                try:
                    os.remove(self.lock_path)
                except OSError:
                    return "ALREADY_RUNNING"
            else:
                return "ALREADY_RUNNING"  # 有 run 进行中：不启动第二 worker
        try:
            fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"run_id": self.run_id, "pid": self.pid,
                           "start_ts": time.time(), "done": False}, f)
            return "NEW"
        except OSError:
            return "ALREADY_RUNNING"  # 并发创建竞争

    def release_lock(self, done=False):
        try:
            if self._lock_exists():
                lock = self._read_lock()
                lock["done"] = done
                lock["end_ts"] = time.time()
                # 原子更新 lock（保留为运行证据）
                tmp = self.lock_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(lock, f, ensure_ascii=False)
                os.replace(tmp, self.lock_path)
        except OSError:
            pass

    # ---- receipt（原子落盘） ----
    def write_receipt(self, receipt_path, exit_code, detail=None):
        payload = {
            "schema_version": 1,
            "run_id": self.run_id,
            "pid": self.pid,
            "exit_code": exit_code,
            "install_calls": 1,
            "detail": detail or {},
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        os.makedirs(os.path.dirname(receipt_path), exist_ok=True)
        tmp = receipt_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
            f.flush()
        os.replace(tmp, receipt_path)  # 原子

    # ---- 单次 install（worker 主流程） ----
    def run_install(self, binding_id, receipt_path):
        status = self.acquire_lock()
        if status == "ALREADY_RUNNING":
            return {"status": "ALREADY_RUNNING", "run_id": self.run_id,
                    "pid": self.pid}
        if status == "ALREADY_DONE":
            # 返回已有 receipt（不再启动 install）
            with open(receipt_path, "r", encoding="utf-8") as f:
                rec = json.load(f)
            return {"status": "ALREADY_DONE", "receipt": rec}
        # NEW：执行 install（TrialRunner 内部 install 计数=1 + journal 零断言）
        try:
            from memory_engine.lifecycle_ctl import LifecycleController
            runner = TrialRunner(self.state_root)
            result = runner.install_once(
                binding_id, lambda: LifecycleController(state_root=self.state_root))
            # 收尾核验：journal 零 + binding 完整
            leftovers = [f for f in os.listdir(self.state_root)
                         if f.startswith(".journal-")]
            if leftovers:
                raise TrialStop("worker 收尾 journal 残留: %s" % leftovers)
            st = runner.status(binding_id) if hasattr(runner, "status") \
                else LifecycleController(state_root=self.state_root).status(binding_id)
            self.write_receipt(receipt_path, 0, detail={
                "binding_state": st.get("binding"),
                "truth": st.get("truth"),
                "session": st.get("session"),
                "journal_count": 0,
                "install_calls": runner.install_calls,
            })
            self.release_lock(done=True)
            return {"status": "DONE", "run_id": self.run_id, "pid": self.pid,
                    "binding": st.get("binding"), "truth": st.get("truth")}
        except BaseException as e:
            self.write_receipt(receipt_path, 1,
                               detail={"error": "%s: %s" % (type(e).__name__, e)})
            self.release_lock(done=True)
            return {"status": "FAILED", "run_id": self.run_id,
                    "error": str(e)}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--state-root", required=True)
    ap.add_argument("--binding", required=True)
    ap.add_argument("--receipt", required=True)
    args = ap.parse_args(argv)

    worker = TrialWorker(args.state_root, args.run_id)
    result = worker.run_install(args.binding, args.receipt)
    print(json.dumps(result, ensure_ascii=False, indent=1))
    if result["status"] in ("ALREADY_RUNNING",):
        return 3
    if result["status"] == "FAILED":
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
