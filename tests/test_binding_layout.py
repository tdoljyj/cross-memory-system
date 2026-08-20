#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R2 Binding 布局测试（BINDING_LAYOUT_INCOMPATIBLE 修复）。

覆盖（产品所有者裁决）：
- R3 install 后 list_bindings 可枚举；
- find_by_agent 可唯一定位；
- 三轴状态无漂移；
- verifier、TruthStateStore 与 LifecycleController 指向同一物理 Binding；
- 双格式冲突（扁平 + 目录）fail-closed 阻断；
- 其他 Binding 与 canonical memory 零影响；
- 幂等 install 后 journal=0。

运行：python tests/test_binding_layout.py
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

from memory_engine.lifecycle_ctl import LifecycleController, LifecycleError  # noqa: E402
from memory_engine.truth import TruthStateStore, ConformanceVerifier  # noqa: E402

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


def _ctrl(tmp):
    return LifecycleController(os.path.join(tmp, "state"))


def _canonical(state, bid):
    """P0-1：三轴状态规范路径 = state.json"""
    return os.path.join(state, bid, "state.json")


def _manifest(state, bid):
    """P0-1：Clued manifest 路径 = binding.json"""
    return os.path.join(state, bid, "binding.json")


@register
def test_install_writes_directory_layout():
    """P0-1：安装必须原子创建 binding.json（manifest）+ state.json（三轴）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        state = os.path.join(tmp, "state")
        _check(os.path.isfile(_manifest(state, "b1")),
               "binding.json（manifest）存在")
        _check(os.path.isfile(_canonical(state, "b1")),
               "state.json（三轴）存在")
        _check(not os.path.isfile(os.path.join(state, "b1.json")),
               "无扁平残留（新写入）")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_install_manifest_passes_clued_validation():
    """P0-1 验收：安装产出的 binding.json 必须通过 clued registry manifest 校验
    （这是 clued doctor 在兼容 fixture 中 PASS 的前提）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("codex-workbuddy-windows-primary")
        state = os.path.join(tmp, "state")
        with open(_manifest(state, "codex-workbuddy-windows-primary"),
                  encoding="utf-8") as f:
            man = json.load(f)
        from clued.manifests import validate_binding_manifest
        ok, err = validate_binding_manifest(man)
        _check(ok, "安装产出 manifest 校验失败: %s" % err)
        _check(man["schema_version"] == "clued.binding.v0.1", "schema 版本正确")
        _check(man["binding_id"] == "codex-workbuddy-windows-primary",
               "binding_id 关联")
        _check(man["scopes"], "scopes 非空")
        # state.json 与 manifest 通过 binding_id 关联
        with open(_canonical(state, "codex-workbuddy-windows-primary"),
                  encoding="utf-8") as f:
            st = json.load(f)
        _check(st["binding_id"] == man["binding_id"], "state 与 manifest 的 binding_id 一致")
        _check(st["schema_version"] == "lifecycle.state.v0.1", "state schema 版本")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_manifest_only_half_created_fail_closed():
    """P0-1：仅 manifest 无 state.json（半创建）→ CLD-LAYOUT-004 fail-closed。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        state = os.path.join(tmp, "state")
        c = LifecycleController(state_root=state)
        c.install("b1")
        # 模拟半创建：删除 state.json，保留 binding.json（manifest）
        os.remove(_canonical(state, "b1"))
        try:
            c.load("b1")
            raise AssertionError("半创建必须 fail-closed")
        except LifecycleError as e:
            _check(e.code == "CLD-LAYOUT-004", "fail-closed 码 CLD-LAYOUT-004")
        _check(c.list_bindings() == [], "半创建不进入枚举")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_legacy_binding_json_read_only():
    """P0-1：legacy 三轴 binding.json 兼容读（directory-legacy），写入拒绝
    （CLD-LAYOUT-003，须先迁移；真实 Binding 现状保护）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        state = os.path.join(tmp, "state")
        os.makedirs(os.path.join(state, "b1"))
        with open(_manifest(state, "b1"), "w", encoding="utf-8") as f:
            json.dump({"binding": "ACTIVE", "session": "ONLINE",
                       "truth": "ENFORCED", "binding_id": "b1",
                       "updated_at": time.time()}, f)
        c = LifecycleController(state_root=state)
        st = c.load("b1")
        _check(st is not None and st["_layout"] == "directory-legacy",
               "legacy 兼容读标记 directory-legacy")
        _check(st["truth"] == "ENFORCED", "legacy 状态可读")
        try:
            c.save("b1", {"binding": "ACTIVE", "session": "ONLINE",
                          "truth": "ADVISORY"})
            raise AssertionError("legacy 写入必须拒绝")
        except LifecycleError as e:
            _check(e.code == "CLD-LAYOUT-003", "写入拒绝码 CLD-LAYOUT-003")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_list_bindings_enumerates():
    """install 后 list_bindings 可枚举（对齐 clued 枚举器）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        c.install("b2")
        found = c.list_bindings()
        ids = sorted(b.get("binding_id") for b in found)
        _check(ids == ["b1", "b2"], "list_bindings 枚举 %s（实际 %s）" % (["b1", "b2"], ids))
        # 点文件（journal/lock）不被枚举
        state = os.path.join(tmp, "state")
        with open(os.path.join(state, ".trial-run.lock"), "w") as f:
            f.write("{}")
        _check(len(c.list_bindings()) == 2, "点文件不影响枚举")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_find_by_agent_unique():
    """find_by_agent 可唯一定位。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        c.install("b2")
        b = c.find_by_agent("b1")
        _check(b is not None and b["binding_id"] == "b1", "唯一定位 b1")
        _check(b["binding"] == "ACTIVE" and b["truth"] == "ADVISORY", "状态一致")
        _check(c.find_by_agent("nope") is None, "不存在返回 None")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_three_axis_no_drift():
    """install → status 三轴无漂移。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        st = c.status("b1")
        _check(st["binding"] == "ACTIVE" and st["session"] == "ONLINE"
               and st["truth"] == "ADVISORY", "三轴 ACTIVE/ONLINE/ADVISORY")
        raw = json.load(open(_canonical(os.path.join(tmp, "state"), "b1"),
                              encoding="utf-8"))
        _check(raw["binding"] == st["binding"] and raw["truth"] == st["truth"],
               "物理文件与 status 一致")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_same_physical_binding_across_components():
    """verifier / TruthStateStore / LifecycleController 指向同一物理 Binding。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        state = os.path.join(tmp, "state")
        # TruthStateStore 写入同一 binding 的证据（绑定 adapter/revision）
        store = TruthStateStore(os.path.join(tmp, "evidence"))
        ev = hashlib.sha256(b"e1").hexdigest()
        store.write("b1", "truth-enabled", "r1", ev, "ADVISORY",
                    evidence_meta={"verified_at": time.time()})
        # verifier 判定基于同一 binding_id + adapter + revision
        v = ConformanceVerifier(truth_state_store=store)
        from memory_engine.truth import TruthReceipt, schema as TS
        rec = TruthReceipt().issue(
            [{"claim_type": "LIFECYCLE_STATE", "value": "ACTIVE",
              "status": TS.VERDICT_VERIFIED}],
            bound_evidence_head="a" * 40)
        cap, _s = v.verify("truth-enabled", "b1", "r1", receipt=rec,
                           conformance_evidence=ev, environment="isolated")
        _check(cap == "ENFORCED", "verifier 与 store 强绑定同一 binding")
        # LifecycleController 状态一致
        _check(c.find_by_agent("b1")["binding_id"] == "b1", "controller 同一 binding")
        _check(os.path.isfile(_canonical(state, "b1")), "物理文件唯一")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_dual_format_conflict_fail_closed():
    """同一 Binding 同时出现扁平与目录 → fail-closed（禁止猜测/自动合并）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        state = os.path.join(tmp, "state")
        # 人为制造双格式：在目录布局外再写扁平文件
        with open(os.path.join(state, "b1.json"), "w") as f:
            json.dump({"binding": "BROKEN", "session": "OFFLINE",
                       "truth": "UNAVAILABLE", "binding_id": "b1"}, f)
        try:
            c.load("b1")
            raise AssertionError("双格式必须 fail-closed")
        except LifecycleError as e:
            _check(e.code == "CLD-LAYOUT-001", "fail-closed 码 CLD-LAYOUT-001")
        try:
            c.save("b1", {"binding": "ACTIVE"})
            raise AssertionError("双格式下 save 必须 fail-closed")
        except LifecycleError as e:
            _check(e.code == "CLD-LAYOUT-001", "save 同样 fail-closed")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_other_bindings_and_memory_untouched():
    """其他 Binding 与 canonical memory 零影响。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        c.install("b2")
        before = json.dumps(c.find_by_agent("b2"), sort_keys=True)
        c.install("b3")
        after = json.dumps(c.find_by_agent("b2"), sort_keys=True)
        _check(before == after, "其他 Binding 零修改")
        # canonical memory 路径不受 controller 影响（controller 只写 state_root）
        mem = os.path.join(tmp, "memory")
        os.makedirs(mem)
        with open(os.path.join(mem, "x.md"), "w") as f:
            f.write("data")
        h_before = hashlib.sha256(open(os.path.join(mem, "x.md"), "rb").read()).hexdigest()
        c.install("b4")
        h_after = hashlib.sha256(open(os.path.join(mem, "x.md"), "rb").read()).hexdigest()
        _check(h_before == h_after, "memory 文件零修改")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_idempotent_install_journal_zero():
    """幂等 install 后 journal=0（目录布局下）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        c = _ctrl(tmp)
        state = os.path.join(tmp, "state")
        c.install("b1")
        st2 = c.install("b1")
        _check(st2["note"] == "ALREADY_INSTALLED", "幂等返回")
        journals = [f for f in os.listdir(state) if f.startswith(".journal-")]
        _check(journals == [], "幂等后 journal=0")
        _check(len([f for f in os.listdir(state) if f == "b1"]) == 1,
               "binding 目录唯一")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_flat_migration_compat_read():
    """扁平文件仅受控迁移兼容读（标记 _layout=flat-migration，不写回）。"""
    tmp = tempfile.mkdtemp(prefix="bl-")
    try:
        state = os.path.join(tmp, "state")
        os.makedirs(state)
        with open(os.path.join(state, "b1.json"), "w") as f:
            json.dump({"binding": "ACTIVE", "session": "ONLINE",
                       "truth": "ADVISORY", "binding_id": "b1"}, f)
        c = LifecycleController(state_root=state)
        st = c.load("b1")
        _check(st is not None and st["_layout"] == "flat-migration",
               "扁平兼容读标记 flat-migration")
        _check(st["binding"] == "ACTIVE" and st["truth"] == "ADVISORY", "状态一致")
        _check(not os.path.isdir(os.path.join(state, "b1")),
               "兼容读不写回目录布局")
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
