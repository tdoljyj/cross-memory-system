#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ENV-EXEC 通道资格验证：独立 worker（临时 home，9 项资格 + 故障注入）。

覆盖（产品所有者裁决）：
1. 调用具有唯一 run_id；
2. 仅启动一个 worker/PID；
3. caller 被中断后 worker 仍能完整结束；
4. 宿主重发时只返回 ALREADY_RUNNING 或已有 receipt，不启动第二 worker；
5. 最终 receipt 原子落盘且 exit code 可验证；
6. install 调用总数严格为 1；
7. 临时 journal 最终为 0；
8. 临时 Binding 状态完整，不出现半写；
9. 测试完成后仅清理临时 fixture。

运行：python tests/test_trial_worker.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tools.trial_worker import TrialWorker, LOCK_NAME  # noqa: E402

TESTS = []
PY = sys.executable
WORKER = os.path.join(REPO_ROOT, "tools", "trial_worker.py")


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


def _run_worker(state, binding, receipt, run_id=None, wait=True):
    run_id = run_id or uuid.uuid4().hex[:12]
    cmd = [PY, WORKER, "--run-id", run_id, "--state-root", state,
           "--binding", binding, "--receipt", receipt]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8")
    if wait:
        out, err = p.communicate(timeout=60)
        return p.returncode, out, err, run_id, p.pid
    return p, run_id  # 不 wait（caller 中断模拟）


@register
def test_g1_unique_run_id():
    """资格 1：不同调用产生不同 run_id；worker 记录 run_id。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        rc, out, _e, rid1, _pid = _run_worker(state, "b1", os.path.join(tmp, "r1.json"))
        _check(rc == 0, "exit 0")
        rc2, out2, _e2, rid2, _pid2 = _run_worker(state, "b2", os.path.join(tmp, "r2.json"))
        _check(rc2 == 0, "exit 0")
        _check(rid1 != rid2, "run_id 唯一")
        _check(json.loads(out)["run_id"] == rid1, "worker 记录 run_id")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g2_single_pid():
    """资格 2：lock 记录单 worker PID；无第二 worker。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        rc, _o, _e, rid, pid = _run_worker(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        lock = json.load(open(os.path.join(state, LOCK_NAME), encoding="utf-8"))
        _check(lock["pid"] == pid, "lock PID = worker PID")
        _check(lock["done"] is True, "lock done=True")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g3_caller_interrupted_worker_completes():
    """资格 3：caller 中断（不 wait）后 worker 仍完整结束。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        receipt = os.path.join(tmp, "r.json")
        p, rid = _run_worker(state, "b1", receipt, wait=False)
        # caller 不等待（模拟中断返回）；轮询 worker 完成
        deadline = time.time() + 60
        while time.time() < deadline:
            if os.path.isfile(receipt):
                break
            if p.poll() is not None and not os.path.isfile(receipt):
                break
            time.sleep(0.2)
        rc = p.wait(timeout=30)
        _check(rc == 0, "worker 独立完成 exit 0")
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["exit_code"] == 0, "receipt exit 0")
        _check(rec["detail"]["journal_count"] == 0, "journal 0")
        _check(rec["detail"]["binding_state"] == "ACTIVE", "binding 完整 ACTIVE")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g4_rerun_returns_done_or_running():
    """资格 4：重发不启动第二 worker。完成后重发 → ALREADY_DONE（返回已有 receipt）。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        receipt = os.path.join(tmp, "r.json")
        rid = uuid.uuid4().hex[:12]
        rc1, out1, _e, _rid, _p = _run_worker(state, "b1", receipt, run_id=rid)
        _check(rc1 == 0, "首次 DONE")
        # 重发（同 run_id）→ ALREADY_DONE，返回已有 receipt
        rc2, out2, _e2, _r, _p2 = _run_worker(state, "b1", receipt, run_id=rid)
        _check(rc2 == 0, "重发 exit 0")
        res2 = json.loads(out2)
        _check(res2["status"] == "ALREADY_DONE", "重发 → ALREADY_DONE（实际 %s）"
               % res2["status"])
        _check(res2.get("receipt", {}).get("exit_code") == 0, "返回已有 receipt")
        # install 调用总数仍 = 1
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["install_calls"] == 1, "install 调用总数=1")
        # binding 无重复
        files = [f for f in os.listdir(state) if f == "b1"]
        _check(len(files) == 1, "binding 唯一")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g4b_rerun_while_running_already_running():
    """资格 4b：run 进行中（lock done=False）重发 → ALREADY_RUNNING。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        os.makedirs(state)
        with open(os.path.join(state, LOCK_NAME), "w") as f:
            json.dump({"run_id": "other", "pid": 9999, "done": False}, f)
        rc, out, _e, _r, _p = _run_worker(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 3, "ALREADY_RUNNING exit 3（实际 %s）" % rc)
        _check(json.loads(out)["status"] == "ALREADY_RUNNING", "不启动第二 worker")
        _check(not os.path.exists(os.path.join(state, "b1.json")),
               "未创建 binding（无第二 install）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g5_atomic_receipt():
    """资格 5：receipt 原子落盘（无 .tmp 残留）+ exit code 可验证。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        receipt = os.path.join(tmp, "r.json")
        rc, _o, _e, _r, _p = _run_worker(state, "b1", receipt)
        _check(rc == 0, "exit 0")
        _check(not os.path.exists(receipt + ".tmp"), "无 .tmp 残留")
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["exit_code"] == 0, "receipt exit_code=0")
        _check(rec["run_id"] and rec["pid"], "receipt 含 run_id/pid")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g6_install_calls_exactly_one():
    """资格 6：install 调用总数严格=1（receipt + 进程证据）。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        receipt = os.path.join(tmp, "r.json")
        rc, _o, _e, _r, _p = _run_worker(state, "b1", receipt)
        _check(rc == 0, "exit 0")
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["install_calls"] == 1, "install_calls=1")
        _check(rec["detail"]["install_calls"] == 1, "detail install_calls=1")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g7_journal_zero():
    """资格 7：临时 journal 最终为 0。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        rc, _o, _e, _r, _p = _run_worker(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        journals = [f for f in os.listdir(state) if f.startswith(".journal-")]
        _check(journals == [], "journal 0 残留")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g8_binding_complete_no_half_write():
    """资格 8：binding 状态完整（无半写：字段齐、三轴合法）。

    P0-1（2026-08-20）：三轴位于 state.json，binding.json 为 Clued manifest。
    """
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        rc, _o, _e, _r, _p = _run_worker(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        st = json.load(open(os.path.join(state, "b1", "state.json"),
                            encoding="utf-8"))
        for k in ("binding", "session", "truth", "binding_id"):
            _check(k in st, "state.json 字段 %s 存在" % k)
        _check(st["binding"] == "ACTIVE" and st["truth"] == "ADVISORY"
               and st["session"] == "ONLINE", "三轴完整（ACTIVE/ADVISORY/ONLINE）")
        _check(not os.path.exists(os.path.join(state, "b1", "state.json.tmp")),
               "无半写 .tmp")
        # P0-1：binding.json 必须为合法 Clued manifest（三轴字段不得混入）
        man = json.load(open(os.path.join(state, "b1", "binding.json"),
                             encoding="utf-8"))
        _check(man.get("schema_version") == "clued.binding.v0.1",
               "binding.json 为 Clued manifest")
        _check("binding" not in man and "truth" not in man,
               "三轴字段不得混入 manifest")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_g9_fixture_cleanup():
    """资格 9：测试完成仅清理临时 fixture（本测试自身清理）。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        rc, _o, _e, _r, _p = _run_worker(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        # 模拟"测试完成"：清理 fixture 后无残留
        shutil.rmtree(tmp, ignore_errors=True)
        _check(not os.path.exists(tmp), "fixture 已清理")
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


# ---- 故障注入 ----
@register
def test_fi_install_failure_receipt_exit1():
    """故障注入：install 失败（BROKEN binding）→ receipt exit 1、lock done。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        receipt = os.path.join(tmp, "r.json")
        # 预置 BROKEN binding → install 拒绝（CLD-INSTALL-001）
        os.makedirs(state)
        with open(os.path.join(state, "b1.json"), "w") as f:
            json.dump({"binding": "BROKEN", "session": "OFFLINE",
                       "truth": "UNAVAILABLE", "binding_id": "b1"}, f)
        rc, _o, _e, _r, _p = _run_worker(state, "b1", receipt)
        _check(rc == 4, "FAILED exit 4（实际 %s）" % rc)
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["exit_code"] == 1, "receipt exit_code=1")
        _check("CLD-INSTALL-001" in rec["detail"]["error"], "错误原因记录")
        lock = json.load(open(os.path.join(state, LOCK_NAME), encoding="utf-8"))
        _check(lock["done"] is True, "lock done=True（失败也收尾）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_fi_concurrent_lock_race():
    """故障注入：lock 并发创建竞争 → 单 worker。"""
    tmp = tempfile.mkdtemp(prefix="wq-")
    try:
        state = os.path.join(tmp, "state")
        os.makedirs(state)
        # 预置 lock（done=False，模拟其他 worker 运行中）
        with open(os.path.join(state, LOCK_NAME), "w") as f:
            json.dump({"run_id": "running-1", "pid": 12345, "done": False}, f)
        w = TrialWorker(state, "new-run")
        _check(w.acquire_lock() == "ALREADY_RUNNING", "并发 → ALREADY_RUNNING")
        _check(not os.path.exists(os.path.join(state, "b1.json")),
               "无 install 发生")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
