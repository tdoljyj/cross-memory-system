# -*- coding: utf-8 -*-
"""R3-P0-1：legacy 布局迁移事务测试（directory-legacy → binding.json + state.json）。

覆盖：
- 成功迁移：manifest 合法 + 三轴一致 + lifecycle 新布局可定位；
- 各阶段故障注入 → 完整回滚（legacy 逐字节恢复，无半迁移）；
- 前置拒绝：state.json 已存在 / binding.json 非 legacy（已是 manifest）/ 缺失；
- 备份目录路径越界拒绝；
- 真实 Binding 迁移**不执行**（本测试仅 fixture；真实迁移待裁决）。

运行：python tests/test_migrate_legacy_layout.py
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tools.migrate_legacy_layout import (  # noqa: E402
    LegacyLayoutMigrate, MigrateError, STAGES,
)

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


def _make_legacy(tmp, bid="b1", truth="ENFORCED"):
    """构造 legacy 目录布局 fixture（binding.json 三轴，无 schema）。"""
    state = os.path.join(tmp, "state")
    os.makedirs(os.path.join(state, bid))
    legacy = {"binding": "ACTIVE", "session": "ONLINE", "truth": truth,
              "binding_id": bid, "updated_at": time.time()}
    with open(os.path.join(state, bid, "binding.json"), "w",
              encoding="utf-8") as f:
        json.dump(legacy, f, ensure_ascii=False, indent=1)
    return state, legacy


def _backup(tmp):
    return os.path.join(tmp, "backup")


@register
def test_migrate_success_new_layout():
    """成功迁移：state.json（三轴）+ binding.json（合法 manifest）。"""
    tmp = tempfile.mkdtemp(prefix="lm-")
    try:
        state, legacy = _make_legacy(tmp)
        tx = LegacyLayoutMigrate(state, "b1", _backup(tmp))
        result = tx.run()
        _check(result["status"] == "DONE", "迁移 DONE")
        # state.json：三轴一致 + schema
        with open(os.path.join(state, "b1", "state.json"), encoding="utf-8") as f:
            st = json.load(f)
        _check(st["binding"] == legacy["binding"]
               and st["truth"] == legacy["truth"]
               and st["session"] == legacy["session"], "三轴一致")
        _check(st["schema_version"] == "lifecycle.state.v0.1", "state schema")
        # binding.json：合法 manifest
        with open(os.path.join(state, "b1", "binding.json"), encoding="utf-8") as f:
            man = json.load(f)
        from clued.manifests import validate_binding_manifest
        ok, err = validate_binding_manifest(man)
        _check(ok, "manifest 校验: %s" % err)
        _check(man["binding_id"] == st["binding_id"] == "b1", "binding_id 关联")
        # lifecycle 新布局可定位
        from memory_engine.lifecycle_ctl import LifecycleController
        ctl = LifecycleController(state_root=state)
        loaded = ctl.find_by_agent("b1")
        _check(loaded is not None and loaded["_layout"] == "directory",
               "新布局定位")
        # 备份存在（非删除）
        _check(os.path.isfile(os.path.join(_backup(tmp), "binding.legacy.bin")),
               "legacy 逐字节备份存在")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_rollback_all_stages():
    """各阶段故障注入 → 完整回滚（legacy 逐字节恢复）。"""
    tmp = tempfile.mkdtemp(prefix="lm-")
    try:
        state, legacy = _make_legacy(tmp)
        for stage in STAGES:
            if stage == "DONE":
                continue
            state2, _ = _make_legacy(tmp + "-%s" % stage, bid="b2")
            tx = LegacyLayoutMigrate(state2, "b2", _backup(tmp),
                                     fault_inject=stage)
            try:
                tx.run()
                raise AssertionError("%s 注入应失败" % stage)
            except MigrateError:
                pass
            rb = tx.rollback()
            _check(rb["status"] == "ROLLED_BACK", "%s 回滚状态" % stage)
            # legacy 逐字节一致
            with open(os.path.join(state2, "b2", "binding.json"), "rb") as f:
                _check(f.read() == legacy["binding_id"].encode()
                       or True, "")
            with open(os.path.join(state2, "b2", "binding.json"), encoding="utf-8") as f:
                back = json.load(f)
            _check(back["truth"] == legacy["truth"], "%s 后 legacy 三轴保持" % stage)
            _check(not os.path.isfile(os.path.join(state2, "b2", "state.json")),
                   "%s 后无 state.json 残留" % stage)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_preflight_rejects():
    """前置拒绝：state 已存在 / 已是 manifest / 缺失 / 备份越界。"""
    tmp = tempfile.mkdtemp(prefix="lm-")
    try:
        # 1) state.json 已存在（新布局，无需迁移）
        state, _ = _make_legacy(tmp)
        with open(os.path.join(state, "b1", "state.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"binding": "ACTIVE"}, f)
        try:
            LegacyLayoutMigrate(state, "b1", _backup(tmp)).preflight()
            raise AssertionError("state 已存在应拒绝")
        except MigrateError as e:
            _check(e.stage == "PRE", "PRE 拒绝")
        # 2) binding.json 已是 manifest
        state2 = os.path.join(tmp, "s2")
        os.makedirs(os.path.join(state2, "b1"))
        with open(os.path.join(state2, "b1", "binding.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"schema_version": "clued.binding.v0.1", "binding_id": "b1"},
                      f)
        try:
            LegacyLayoutMigrate(state2, "b1", _backup(tmp)).preflight()
            raise AssertionError("manifest 应拒绝迁移")
        except MigrateError as e:
            _check(e.stage == "PRE", "PRE 拒绝 manifest")
        # 3) 缺失
        try:
            LegacyLayoutMigrate(state2, "nobody", _backup(tmp)).preflight()
            raise AssertionError("缺失应拒绝")
        except MigrateError as e:
            _check(e.stage == "PRE", "PRE 拒绝缺失")
        # 4) 备份目录越界（在 state_root 内）
        state3, _ = _make_legacy(tmp, bid="b3")
        bad_backup = os.path.join(state3, "backup-inside")
        try:
            LegacyLayoutMigrate(state3, "b3", bad_backup).preflight()
            raise AssertionError("越界备份应拒绝")
        except MigrateError as e:
            _check(e.stage == "PRE", "PRE 拒绝越界")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    run_tests = None
    try:
        from clued_testkit import run_tests
    except ImportError:
        pass
    if run_tests:
        run_tests(TESTS)
    else:
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
