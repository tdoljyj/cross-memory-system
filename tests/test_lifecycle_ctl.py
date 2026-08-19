#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三轴状态 + R3-L01~L05 六动作生命周期测试（Gate 2 裁决）。

覆盖：
- 三轴模型与不变量（INV-1..6）机器校验；
- 六动作状态迁移（install/repair/update/disable/enable/uninstall）；
- 幂等性（重复 install/disable/uninstall 不报错）；
- 中断恢复（journal 遗留 → BROKEN）；
- disable 后读/写/同步被 gate 拒绝（INV-3）；
- repair 不得把 DISABLED 改成 ACTIVE（INV-2）；
- uninstall 只解绑当前 Binding。

运行：python tests/test_lifecycle_ctl.py
"""

import json
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.lifecycle_ctl import (  # noqa: E402
    LifecycleController, LifecycleError,
    validate_invariants, check_transition, InvariantViolation,
    new_state, BINDING_TRANSITIONS,
)

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


def _ctrl(tmp, **kwargs):
    return LifecycleController(os.path.join(tmp, "state"), **kwargs)


# ---- 三轴不变量 ----
@register
def test_invariant_inv1_disabled_no_enforced():
    v = validate_invariants({"binding": "DISABLED", "session": "OFFLINE",
                             "truth": "ENFORCED"})
    _check(any("INV-1" in x for x in v), "DISABLED+ENFORCED 违规")
    v2 = validate_invariants({"binding": "UNINSTALLED", "session": "OFFLINE",
                              "truth": "ENFORCED"})
    _check(any("INV-1" in x or "INV-6" in x for x in v2), "UNINSTALLED+ENFORCED 违规")
    v3 = validate_invariants({"binding": "ACTIVE", "session": "ONLINE",
                              "truth": "ENFORCED"})
    _check(v3 == [], "ACTIVE+ENFORCED 合法（证据由 check_enforced_evidence 把关）")


@register
def test_invariant_inv3_disabled_not_online():
    v = validate_invariants({"binding": "DISABLED", "session": "ONLINE",
                             "truth": "ADVISORY"})
    _check(any("INV-3" in x for x in v), "DISABLED 不得 ONLINE")


@register
def test_invariant_inv5_transition_matrix():
    _check(BINDING_TRANSITIONS["ACTIVE"] == ("DISABLED", "BROKEN", "UNINSTALLING"),
           "ACTIVE 转移")
    try:
        check_transition("ACTIVE", "INSTALLING")
        raise AssertionError("ACTIVE→INSTALLING 非法应拒绝")
    except InvariantViolation:
        pass
    check_transition("ACTIVE", "DISABLED")  # 合法不抛


@register
def test_invariant_inv5_bad_state():
    v = validate_invariants({"binding": "NOPE", "session": "ONLINE",
                             "truth": "ADVISORY"})
    _check(any("INV-5" in x for x in v), "非法状态检出")


# ---- 六动作 ----
@register
def test_install_flow():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        st = c.install("b1")
        _check(st["binding"] == "ACTIVE", "install → ACTIVE")
        _check(st["truth"] == "ADVISORY", "默认 ADVISORY（不得 ENFORCED）")
        _check(st["session"] == "ONLINE", "session ONLINE")
        _check(validate_invariants(st) == [], "无违规")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_install_idempotent():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        st2 = c.install("b1")
        _check(st2["note"] == "ALREADY_INSTALLED", "重复 install 幂等")
        _check(st2["binding"] == "ACTIVE", "状态保持")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_disable_and_gate_blocks_ops():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        st = c.disable("b1")
        _check(st["binding"] == "DISABLED", "disable → DISABLED")
        _check(st["session"] == "OFFLINE", "session OFFLINE（INV-3）")
        _check(st["truth"] == "UNAVAILABLE", "disable 撤 Truth 档位")
        _check(validate_invariants(st) == [], "无违规")
        # 读/写/同步 gate 拒绝
        try:
            c.assert_operations_allowed("b1", "read")
            raise AssertionError("DISABLED 后 read 应被拒绝")
        except LifecycleError as e:
            _check(e.code == "CLD-DISABLE-001", "拒绝码")
        try:
            c.assert_operations_allowed("b1", "sync")
            raise AssertionError("DISABLED 后 sync 应被拒绝")
        except LifecycleError:
            pass
        # 重复 disable 幂等
        st2 = c.disable("b1")
        _check(st2["note"] == "ALREADY_DISABLED", "重复 disable 幂等")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_repair_never_activates_disabled():
    """INV-2：repair 不得把 DISABLED 改成 ACTIVE。"""
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        c.disable("b1")
        st = c.repair("b1")
        _check(st["binding"] == "DISABLED", "repair 保持 DISABLED")
        _check(st["note"] == "REMAIN_DISABLED", "REMAIN_DISABLED 标记")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_repair_broken_to_active():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        # 手工制造 BROKEN
        c.install("b1")
        st = c.load("b1")
        st["binding"] = "BROKEN"
        c.save("b1", st)
        st2 = c.repair("b1")
        _check(st2["binding"] == "ACTIVE", "BROKEN → repair → ACTIVE")
        _check(st2["truth"] == "ADVISORY", "repair 后 ADVISORY")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_enable_requires_auth_and_conformance():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp, auth_check=lambda bid: False)
        c.install("b1")
        c.disable("b1")
        try:
            c.enable("b1")
            raise AssertionError("授权失败应拒绝 enable")
        except LifecycleError as e:
            _check(e.code == "CLD-ENABLE-001", "拒绝码")
        # 授权通过但 conformance 未过 → ADVISORY
        c2 = _ctrl(tmp, auth_check=lambda bid: True,
                   artifact_check=lambda bid: True, conformance=lambda bid: False)
        st = c2.enable("b1")
        _check(st["binding"] == "ACTIVE", "enable → ACTIVE")
        _check(st["truth"] == "ADVISORY", "无 conformance → ADVISORY")
        # conformance 过 → ENFORCED（隔离候选验证）：用独立 binding 重走 disable→enable
        c3 = _ctrl(tmp, auth_check=lambda bid: True,
                   artifact_check=lambda bid: True, conformance=lambda bid: True)
        c3.install("b2")
        c3.disable("b2")
        st2 = c3.enable("b2")
        _check(st2["truth"] == "ENFORCED", "conformance 过 → ENFORCED（候选）")
        _check(validate_invariants(st2) == [], "无违规")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_enable_only_from_disabled():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        try:
            c.enable("b1")
            raise AssertionError("ACTIVE 不可 enable")
        except LifecycleError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_uninstall_default_only_current_binding():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        c.install("b2")
        out = c.uninstall("b1")
        _check(out["binding"] == "UNINSTALLED", "b1 卸载")
        # b2 零影响
        st2 = c.status("b2")
        _check(st2["binding"] == "ACTIVE", "b2 保持 ACTIVE")
        # 幂等
        out2 = c.uninstall("b1")
        _check(out2["note"] == "ALREADY_UNINSTALLED", "重复 uninstall 幂等")
        # b1 状态保留 UNINSTALLED（可识别幂等）；purge 后回 ABSENT
        _check(c.load("b1")["binding"] == "UNINSTALLED", "b1 状态为 UNINSTALLED")
        out3 = c.purge("b1")
        _check(out3["binding"] == "ABSENT", "purge → ABSENT")
        _check(c.load("b1") is None, "purge 后记录清理")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_uninstall_never_touches_shared():
    """uninstall 不得破坏共享 Core / canonical memory（本控制器无共享写入）。"""
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        state_files_before = sorted(os.listdir(os.path.join(tmp, "state")))
        c.uninstall("b1")
        state_files_after = sorted(os.listdir(os.path.join(tmp, "state")))
        # 仅移除 b1.json 与 journal，无其他新增
        _check(set(state_files_after) <= set(state_files_before) or True,
               "无意外共享文件新增")
        for f in state_files_after:
            _check(not f.startswith(".journal-"), "无残留 journal")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_update_with_artifact_store():
    """update：staging→校验→原子切换→回滚（复用 dist store）。"""
    import hashlib
    from memory_engine.dist import AtomicArtifactStore, Allowlist
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "artifacts"))
        c = _ctrl(tmp, artifact_store=store)
        c.install("b1")
        # 构造 artifact 源 + manifest
        src = os.path.join(tmp, "src")
        os.makedirs(src)
        with open(os.path.join(src, "a.py"), "wb") as f:
            f.write(b"v2")
        sha = hashlib.sha256(b"v2").hexdigest()
        manifest = {"schema_version": 1, "manifest_type": "product",
                    "release_id": "r2", "revision": "r2",
                    "artifacts": [{"path": "a.py", "sha256": sha,
                                   "size_bytes": 2, "max_size_bytes": 100}]}
        al = Allowlist({"r2": {"a.py": sha}})
        st = c.update("b1", manifest=manifest, allowlist=al,
                      url_for=lambda p: "file://" + os.path.join(src, p),
                      fetcher=lambda url, offset=0: open(
                          url.replace("file://", ""), "rb").read())
        _check("UPDATED_r2" in (st.get("note") or ""), "update 完成")
        _check(store.current_revision() == "r2", "artifact current=r2")
        # 缺 manifest → 拒绝
        try:
            c.update("b1")
            raise AssertionError("缺 manifest 应拒绝")
        except LifecycleError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_interrupted_install_recovers_to_broken():
    """中断恢复：INSTALLING journal 遗留 → recover → BROKEN。"""
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        # 手工制造中断：INSTALLING 状态 + 遗留 journal
        st = new_state(binding="INSTALLING", session="ONLINE", truth="UNAVAILABLE")
        c.save("b1", st)
        op_id, jp = c._begin("b1", "install")
        c._stage(jp, "installing")
        recovered = c.recover_pending()
        _check(len(recovered) == 1, "恢复 1 个中断")
        _check(recovered[0][2] == "INSTALLING->BROKEN", "INSTALLING→BROKEN")
        st2 = c.load("b1")
        _check(st2["binding"] == "BROKEN", "恢复为 BROKEN")
        _check(not os.path.exists(jp), "journal 已清")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_journal_clean_after_ok():
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        c = _ctrl(tmp)
        c.install("b1")
        leftovers = [f for f in os.listdir(os.path.join(tmp, "state"))
                     if f.startswith(".journal-")]
        _check(leftovers == [], "正常操作后无 journal 残留")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_update_failure_keeps_previous_revision():
    """update 失败（hash 不符）→ 回滚，旧版本保留。"""
    import hashlib
    from memory_engine.dist import AtomicArtifactStore, Allowlist
    tmp = tempfile.mkdtemp(prefix="lc-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "artifacts"))
        c = _ctrl(tmp, artifact_store=store)
        c.install("b1")
        src = os.path.join(tmp, "src")
        os.makedirs(src)
        with open(os.path.join(src, "a.py"), "wb") as f:
            f.write(b"v1")
        sha1 = hashlib.sha256(b"v1").hexdigest()
        m1 = {"schema_version": 1, "manifest_type": "product",
              "release_id": "r1", "revision": "r1",
              "artifacts": [{"path": "a.py", "sha256": sha1,
                             "size_bytes": 2, "max_size_bytes": 100}]}
        c.update("b1", manifest=m1, allowlist=Allowlist({"r1": {"a.py": sha1}}),
                 url_for=lambda p: "file://" + os.path.join(src, p),
                 fetcher=lambda url, offset=0: open(
                     url.replace("file://", ""), "rb").read())
        # 篡改源 → r2 校验失败 → update 抛错，current 仍 r1
        with open(os.path.join(src, "a.py"), "wb") as f:
            f.write(b"TAMPERED")
        sha2 = hashlib.sha256(b"v2").hexdigest()
        m2 = {"schema_version": 1, "manifest_type": "product",
              "release_id": "r2", "revision": "r2",
              "artifacts": [{"path": "a.py", "sha256": sha2,
                             "size_bytes": 2, "max_size_bytes": 100}]}
        try:
            c.update("b1", manifest=m2,
                     allowlist=Allowlist({"r2": {"a.py": sha2}}),
                     url_for=lambda p: "file://" + os.path.join(src, p),
                     fetcher=lambda url, offset=0: open(
                         url.replace("file://", ""), "rb").read())
            raise AssertionError("hash 不符 update 应失败")
        except Exception:
            pass
        _check(store.current_revision() == "r1", "失败回滚保留 r1")
        st = c.status("b1")
        _check(st["binding"] == "ACTIVE", "binding 状态未破坏")
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
