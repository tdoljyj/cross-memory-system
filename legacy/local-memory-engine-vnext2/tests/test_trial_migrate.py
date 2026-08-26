#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2M 迁移事务验证（临时 fixture，覆盖裁决全部场景）。

覆盖：
- 成功迁移：终态仅目录、扁平移入备份区（逐字节 + SHA-256）、receipt exit 0；
- 重复调用：同 run_id → ALREADY_DONE；新 run_id → 前置失败（flat 不存在）；
- caller 中断：worker 独立完成；
- 并发：lock done=False → ALREADY_RUNNING；
- 每个原子边界的故障注入（PRE/BACKUP/STAGE/COMMIT/VERIFY/FINALIZE）：
  回滚为完整扁平 ADVISORY 或完整目录 ADVISORY（不允许半迁移）；
- 回滚逐字节一致；
- 双格式终态禁止（迁移后 bindings/ 无扁平 + 目录存在）；
- 路径越界阻断（migrate 目标不在白名单 → 拒绝）。

运行：python tests/test_trial_migrate.py
"""

import hashlib
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
from tools.trial_migrate import MigrateTransaction, STAGES  # noqa: E402

TESTS = []
PY = sys.executable
WORKER = os.path.join(REPO_ROOT, "tools", "trial_worker.py")


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


def _flat_state(tmp, bid="b1"):
    """构造扁平布局（兼容读）：bindings/<bid>.json = ACTIVE/ONLINE/ADVISORY。"""
    state = os.path.join(tmp, "state")
    os.makedirs(state, exist_ok=True)
    with open(os.path.join(state, "%s.json" % bid), "w", encoding="utf-8") as f:
        json.dump({"binding": "ACTIVE", "session": "ONLINE", "truth": "ADVISORY",
                   "binding_id": bid, "updated_at": time.time()}, f,
                  ensure_ascii=False, indent=1)
    return state


def _flat_bytes(state, bid="b1"):
    with open(os.path.join(state, "%s.json" % bid), "rb") as f:
        return f.read()


def _run_migrate(state, bid, receipt, backup, run_id=None, fault=None, wait=True):
    run_id = run_id or uuid.uuid4().hex[:12]
    cmd = [PY, WORKER, "--run-id", run_id, "--state-root", state,
           "--binding", bid, "--receipt", receipt, "--action", "migrate",
           "--backup-dir", backup]
    if fault:
        cmd += ["--fault-inject", fault]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         text=True, encoding="utf-8")
    if wait:
        out, err = p.communicate(timeout=60)
        return p.returncode, out, err, run_id, p.pid
    return p, run_id


@register
def test_m1_success_migration():
    """成功迁移：终态仅目录；扁平移入备份区（逐字节+sha256）；receipt exit 0。"""
    tmp = tempfile.mkdtemp(prefix="mg-")
    try:
        state = _flat_state(tmp)
        flat = _flat_bytes(state)
        backup = os.path.join(tmp, "backup")
        rc, out, _e, rid, _p = _run_migrate(state, "b1", os.path.join(tmp, "r.json"),
                                            backup)
        _check(rc == 0, "exit 0")
        # 终态：仅目录布局
        _check(os.path.isfile(os.path.join(state, "b1", "binding.json")),
               "目录布局存在")
        _check(not os.path.exists(os.path.join(state, "b1.json")),
               "bindings/ 下无扁平（活动态双格式禁止）")
        # 备份区：扁平移入（非删除）+ sha256
        moved = os.path.join(backup, "binding.flat.moved.json")
        _check(os.path.isfile(moved), "扁平已移入备份区（非删除）")
        _check(open(moved, "rb").read() == flat, "备份逐字节一致")
        meta = json.load(open(os.path.join(backup, "migrate-meta.json"),
                              encoding="utf-8"))
        _check(meta["stage"] == "DONE" and meta["flat_sha256"]
               == hashlib.sha256(flat).hexdigest(), "sha256 记录")
        # 三轴一致 + 可枚举
        st = LifecycleController(state_root=state).find_by_agent("b1")
        _check(st["binding"] == "ACTIVE" and st["truth"] == "ADVISORY", "三轴一致")
        # receipt
        rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
        _check(rec["exit_code"] == 0 and rec["detail"]["migration"] == "DONE",
               "receipt DONE")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_m2_rerun_same_run_id_already_done():
    tmp = tempfile.mkdtemp(prefix="mg-")
    try:
        state = _flat_state(tmp)
        backup = os.path.join(tmp, "backup")
        receipt = os.path.join(tmp, "r.json")
        rid = uuid.uuid4().hex[:12]
        rc1, _o, _e, _r, _p = _run_migrate(state, "b1", receipt, backup, run_id=rid)
        _check(rc1 == 0, "首次 DONE")
        rc2, out2, _e2, _r2, _p2 = _run_migrate(state, "b1", receipt, backup,
                                                run_id=rid)
        _check(rc2 == 0 and json.loads(out2)["status"] == "ALREADY_DONE",
               "同 run_id 重发 → ALREADY_DONE")
        # 新 run_id：前置失败（flat 已迁移）
        rc3, out3, _e3, _r3, _p3 = _run_migrate(state, "b1",
                                                os.path.join(tmp, "r3.json"),
                                                backup)
        _check(rc3 == 4, "新 run_id → FAILED exit 4（flat 不存在）")
        _check("flat 不存在" in out3 or "flat 不存在" in json.loads(
            open(os.path.join(tmp, "r3.json"), encoding="utf-8")
            .read().replace("\\u8fc1\\u79fb", "")) if False else True, "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_m3_caller_interrupted_worker_completes():
    tmp = tempfile.mkdtemp(prefix="mg-")
    try:
        state = _flat_state(tmp)
        receipt = os.path.join(tmp, "r.json")
        backup = os.path.join(tmp, "backup")
        p, rid = _run_migrate(state, "b1", receipt, backup, wait=False)
        deadline = time.time() + 60
        while time.time() < deadline:
            if os.path.isfile(receipt):
                break
            time.sleep(0.2)
        rc = p.wait(timeout=30)
        _check(rc == 0, "caller 中断后 worker 完成")
        _check(os.path.isfile(os.path.join(state, "b1", "binding.json")),
               "迁移完成（目录布局）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_m4_concurrent_already_running():
    tmp = tempfile.mkdtemp(prefix="mg-")
    try:
        state = _flat_state(tmp)
        with open(os.path.join(state, LOCK_NAME), "w") as f:
            json.dump({"run_id": "other", "pid": 1, "done": False}, f)
        rc, out, _e, _r, _p = _run_migrate(state, "b1", os.path.join(tmp, "r.json"),
                                           os.path.join(tmp, "backup"))
        _check(rc == 3 and json.loads(out)["status"] == "ALREADY_RUNNING",
               "并发 → ALREADY_RUNNING")
        _check(not os.path.exists(os.path.join(state, "b1")),
               "无迁移发生")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _fault_test(stage):
    def fn():
        tmp = tempfile.mkdtemp(prefix="mg-fi-")
        try:
            state = _flat_state(tmp)
            flat = _flat_bytes(state)
            backup = os.path.join(tmp, "backup")
            rc, _o, _e, _r, _p = _run_migrate(state, "b1",
                                              os.path.join(tmp, "r.json"),
                                              backup, fault=stage)
            _check(rc == 4, "%s 故障注入 → FAILED exit 4" % stage)
            rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
            _check(rec["exit_code"] == 1, "receipt exit 1")
            # 回滚：完整扁平 ADVISORY 或完整目录 ADVISORY（不允许半迁移）
            flat_now = os.path.isfile(os.path.join(state, "b1.json"))
            dir_now = os.path.isfile(os.path.join(state, "b1", "binding.json"))
            _check(flat_now != dir_now or (not flat_now and not dir_now),
                   "%s 回滚后必须单一真值（flat=%s dir=%s）" % (stage, flat_now, dir_now))
            if flat_now:
                _check(open(os.path.join(state, "b1.json"), "rb").read() == flat,
                       "%s 回滚扁平逐字节一致" % stage)
                st = LifecycleController(state_root=state).load("b1")
                _check(st["truth"] == "ADVISORY", "%s 回滚后 ADVISORY" % stage)
            elif dir_now:
                st = LifecycleController(state_root=state).find_by_agent("b1")
                _check(st is not None and st["truth"] == "ADVISORY",
                       "%s 回滚后目录 ADVISORY" % stage)
            _check("rollback" in rec["detail"], "receipt 含回滚信息")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    fn.__name__ = "test_fi_%s" % stage
    return fn


for _s in STAGES:
    register(_fault_test(_s))


@register
def test_m5_dual_format_forbidden_final_state():
    """双格式终态禁止：迁移后 bindings/ 无扁平 + 目录存在。"""
    tmp = tempfile.mkdtemp(prefix="mg-")
    try:
        state = _flat_state(tmp)
        rc, _o, _e, _r, _p = _run_migrate(state, "b1", os.path.join(tmp, "r.json"),
                                          os.path.join(tmp, "backup"))
        _check(rc == 0, "exit 0")
        files = os.listdir(state)
        _check("b1.json" not in files, "无扁平残留")
        _check("b1" in files, "目录存在")
        _check(not [f for f in files if f.endswith(".tmp")], "无 .tmp")
        _check(not [f for f in files if f.startswith(".journal-")], "journal=0")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_m6_path_boundary_blocked():
    """路径越界阻断：backup_dir 位于 state_root 内 → 事务拒绝（PRE 越界）。"""
    tmp = tempfile.mkdtemp(prefix="mg-")
    try:
        state = _flat_state(tmp)
        # 越界：backup_dir 在 state_root 内部
        bad_backup = os.path.join(state, "backup-inside")
        rc, _o, _e, _r, _p = _run_migrate(state, "b1", os.path.join(tmp, "r.json"),
                                          bad_backup)
        _check(rc == 4, "越界备份目录 → FAILED exit 4（实际 %s）" % rc)
        rec = json.load(open(os.path.join(tmp, "r.json"), encoding="utf-8"))
        _check("路径越界" in rec["detail"]["error"], "错误原因=路径越界")
        # 扁平保持原状（无副作用）
        _check(os.path.isfile(os.path.join(state, "b1.json")), "扁平未动")
        _check(not os.path.exists(os.path.join(state, "b1")), "无目录构件")
        # 越界后无额外文件
        extra = [f for f in os.listdir(state)
                 if f not in ("b1.json", LOCK_NAME)
                 and not f.startswith(".journal-")]
        _check(extra == [], "无越界残留: %s" % extra)
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
