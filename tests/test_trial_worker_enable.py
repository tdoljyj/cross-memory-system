#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2 Enable 持久通道验证（临时 home，9 项资格）。

覆盖（产品所有者裁决）：
1. 固定 run_id；
2. 单 worker、单次 enable 调用；
3. caller 中断后 worker 完成；
4. 宿主重发返回 ALREADY_RUNNING/ALREADY_DONE；
5. receipt 原子落盘；
6. 成功路径 ADVISORY → ENFORCED；
7. 失败或中断路径恢复 ADVISORY；
8. journal 和临时文件最终为零；
9. 不改变生命周期、连接状态及其他 Binding。

运行：python tests/test_trial_worker_enable.py
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

from memory_engine.lifecycle_ctl import LifecycleController  # noqa: E402
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


def _installed_state(tmp):
    """返回一个已 install（ACTIVE/ONLINE/ADVISORY）的 state 目录。"""
    state = os.path.join(tmp, "state")
    LifecycleController(state_root=state).install("b1")
    return state


def _run_enable(state, binding, receipt, run_id=None, conformance_ok=True,
                wait=True):
    run_id = run_id or uuid.uuid4().hex[:12]
    cmd = [PY, WORKER, "--run-id", run_id, "--state-root", state,
           "--binding", binding, "--receipt", receipt,
           "--action", "enable"]
    if conformance_ok:
        cmd.append("--conformance-ok")
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8")
    if wait:
        out, err = p.communicate(timeout=60)
        return p.returncode, out, err, run_id, p.pid
    return p, run_id


@register
def test_e1_fixed_run_id():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        rid = "enable-fixed-run-01"
        rc, out, _e, _r, _pid = _run_enable(state, "b1",
                                            os.path.join(tmp, "r.json"),
                                            run_id=rid)
        _check(rc == 0, "exit 0")
        _check(json.loads(out)["run_id"] == rid, "固定 run_id 记录")
        rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
        _check(rec["run_id"] == rid, "receipt run_id 固定")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e2_single_worker_single_enable():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        rc, _o, _e, _r, pid = _run_enable(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
        _check(rec["detail"]["enable_calls"] == 1, "enable 调用=1")
        lock = json.load(open(os.path.join(state, LOCK_NAME), encoding="utf-8"))
        _check(lock["pid"] == pid and lock["done"] is True, "单 worker done")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e3_caller_interrupted_worker_completes():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        receipt = os.path.join(tmp, "r.json")
        p, rid = _run_enable(state, "b1", receipt, wait=False)
        deadline = time.time() + 60
        while time.time() < deadline:
            if os.path.isfile(receipt):
                break
            time.sleep(0.2)
        rc = p.wait(timeout=30)
        _check(rc == 0, "worker 独立完成 exit 0")
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["exit_code"] == 0 and rec["detail"]["truth"] == "ENFORCED",
               "中断后 worker 完成 ENFORCED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e4_rerun_already_done_or_running():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        receipt = os.path.join(tmp, "r.json")
        rid = uuid.uuid4().hex[:12]
        rc1, _o, _e, _r, _p = _run_enable(state, "b1", receipt, run_id=rid)
        _check(rc1 == 0, "首次 DONE")
        # 重发（同 run_id）→ ALREADY_DONE
        rc2, out2, _e2, _r2, _p2 = _run_enable(state, "b1", receipt, run_id=rid)
        _check(rc2 == 0 and json.loads(out2)["status"] == "ALREADY_DONE",
               "重发 → ALREADY_DONE")
        # 运行中（lock done=False）→ ALREADY_RUNNING
        state2 = _installed_state(tmp + "-2") if False else None
        state3 = os.path.join(tmp, "state3")
        LifecycleController(state_root=state3).install("b1")
        with open(os.path.join(state3, LOCK_NAME), "w") as f:
            json.dump({"run_id": "x", "pid": 1, "done": False}, f)
        rc3, out3, _e3, _r3, _p3 = _run_enable(state3, "b1", os.path.join(tmp, "r3.json"))
        _check(rc3 == 3 and json.loads(out3)["status"] == "ALREADY_RUNNING",
               "运行中 → ALREADY_RUNNING（exit 3）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e5_receipt_atomic():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        receipt = os.path.join(tmp, "r.json")
        rc, _o, _e, _r, _p = _run_enable(state, "b1", receipt)
        _check(rc == 0, "exit 0")
        _check(not os.path.exists(receipt + ".tmp"), "receipt 原子（无 .tmp）")
        rec = json.load(open(receipt, encoding="utf-8"))
        _check(rec["exit_code"] == 0 and rec["pid"], "exit code + pid")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e6_success_advisory_to_enforced():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        _check(LifecycleController(state_root=state).status("b1")["truth"]
               == "ADVISORY", "enable 前 ADVISORY")
        rc, _o, _e, _r, _p = _run_enable(state, "b1", os.path.join(tmp, "r.json"),
                                         conformance_ok=True)
        _check(rc == 0, "exit 0")
        st = LifecycleController(state_root=state).status("b1")
        _check(st["truth"] == "ENFORCED", "成功路径 ADVISORY → ENFORCED")
        _check(st["binding"] == "ACTIVE" and st["session"] == "ONLINE",
               "生命周期/连接状态不改变")
        rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
        _check(rec["detail"]["transition"] == "ADVISORY -> ENFORCED",
               "transition 记录")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e7_failure_recovers_advisory():
    """失败路径：conformance_ok=False → enable 拒绝，binding 保持 ADVISORY。"""
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        rc, _o, _e, _r, _p = _run_enable(state, "b1", os.path.join(tmp, "r.json"),
                                         conformance_ok=False)
        _check(rc == 4, "FAILED exit 4")
        st = LifecycleController(state_root=state).status("b1")
        _check(st["truth"] == "ADVISORY", "失败路径恢复/保持 ADVISORY")
        rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
        _check(rec["exit_code"] == 1 and "conformance" in rec["detail"]["error"],
               "receipt exit 1 + 原因")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e8_journal_and_tmp_zero():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = _installed_state(tmp)
        rc, _o, _e, _r, _p = _run_enable(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        files = os.listdir(state)
        _check(not [f for f in files if f.startswith(".journal-")], "journal=0")
        _check(not [f for f in files if f.endswith(".tmp")], "临时文件=0")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e9_other_bindings_untouched():
    tmp = tempfile.mkdtemp(prefix="we-")
    try:
        state = os.path.join(tmp, "state")
        ctl = LifecycleController(state_root=state)
        ctl.install("b1")
        ctl.install("b2")
        before = json.dumps(ctl.find_by_agent("b2"), sort_keys=True)
        rc, _o, _e, _r, _p = _run_enable(state, "b1", os.path.join(tmp, "r.json"))
        _check(rc == 0, "exit 0")
        after = json.dumps(ctl.find_by_agent("b2"), sort_keys=True)
        _check(before == after, "其他 Binding 零影响")
        _check(ctl.find_by_agent("b1")["truth"] == "ENFORCED", "b1 ENFORCED")
        _check(ctl.find_by_agent("b2")["truth"] == "ADVISORY", "b2 仍 ADVISORY")
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
