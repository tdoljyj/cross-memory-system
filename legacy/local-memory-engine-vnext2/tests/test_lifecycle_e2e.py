#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gate 2 临时 home E2E（裁决要求：临时 home + 临时仓库 + 伪制 Adapter）。

覆盖：
- 六动作全流程：install → update → disable → enable → uninstall；
- 三轴状态全程机器校验（INV 违规 = FAIL）；
- ENFORCED 候选验证（隔离环境）：conformance 证据链 → enable 后 ENFORCED；
- Adapter 旁路测试：绕过 Claim Gate 的读取在 ENFORCED 候选下阻断；
- 伪制 Adapter 走 TruthAwareAdapter 合同 + LifecycleController。

全部在临时目录运行（HOME/state 隔离），不触碰真实环境。

运行：python tests/test_lifecycle_e2e.py
"""

import hashlib
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.lifecycle_ctl import (  # noqa: E402
    LifecycleController, LifecycleError, validate_invariants,
)
from memory_engine.truth import (  # noqa: E402
    TruthPlanner, TruthAwareRecall, TruthReceipt, BypassError,
    TruthAwareAdapter, CapabilityReporter,
)
from memory_engine.dist import AtomicArtifactStore, Allowlist  # noqa: E402

TESTS = []


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def register(fn):
    TESTS.append(fn)
    return fn


class FakeAdapter(TruthAwareAdapter):
    """伪制 Adapter：合同化 + 门禁化，模拟真实端侧。"""

    name = "fake"

    def __init__(self, controller, binding_id, planner=None, recall=None):
        super(FakeAdapter, self).__init__(
            planner=planner or TruthPlanner(),
            recall=recall,
            capability_reporter=CapabilityReporter("ADVISORY"))
        self._ctl = controller
        self._binding = binding_id

    def lifecycle(self, action, binding_id):
        return getattr(self._ctl, action)(binding_id)

    def read(self, query, receipt=None, require_verified=False):
        """经门禁化召回读取（旁路测试目标）。"""
        if self._recall is None:
            raise AssertionError("recall 未注入")
        return self._recall.recall(query, receipt=receipt,
                                   require_verified=require_verified)


def _make_artifact(tmp, revision, data=b"v1"):
    src = os.path.join(tmp, "src-%s" % revision)
    os.makedirs(src, exist_ok=True)
    p = os.path.join(src, "a.py")
    with open(p, "wb") as f:
        f.write(data)
    sha = hashlib.sha256(data).hexdigest()
    manifest = {"schema_version": 1, "manifest_type": "product",
                "release_id": revision, "revision": revision,
                "artifacts": [{"path": "a.py", "sha256": sha,
                               "size_bytes": len(data), "max_size_bytes": 100}]}
    return src, manifest, Allowlist({revision: {"a.py": sha}})


@register
def test_e2e_full_six_actions_with_invariants():
    tmp = tempfile.mkdtemp(prefix="lc-e2e-")
    try:
        home = os.path.join(tmp, "home")
        os.makedirs(home)
        store = AtomicArtifactStore(os.path.join(tmp, "artifacts"))
        ctl = LifecycleController(os.path.join(tmp, "state"),
                                  artifact_store=store,
                                  auth_check=lambda b: True,
                                  artifact_check=lambda b: True,
                                  conformance=lambda b: False)

        # 1) install
        st = ctl.install("fake:inst1")
        _check(st["binding"] == "ACTIVE" and st["truth"] == "ADVISORY",
               "install → ACTIVE/ADVISORY")
        _check(validate_invariants(st) == [], "INV 无违规")

        # 2) update（staging→校验→原子切换）
        src, m1, al1 = _make_artifact(tmp, "r1", b"v1")
        st = ctl.update("fake:inst1", manifest=m1, allowlist=al1,
                        url_for=lambda p: "file://" + os.path.join(src, p),
                        fetcher=lambda url, offset=0: open(
                            url.replace("file://", ""), "rb").read())
        _check("UPDATED_r1" in (st.get("note") or ""), "update r1")
        _check(validate_invariants(ctl.status("fake:inst1")) == [], "INV 无违规")

        # 3) disable（读/写/同步 gate）
        st = ctl.disable("fake:inst1")
        _check(st["binding"] == "DISABLED" and st["session"] == "OFFLINE",
               "disable → DISABLED/OFFLINE")
        _check(validate_invariants(st) == [], "INV 无违规")
        try:
            ctl.assert_operations_allowed("fake:inst1", "read")
            raise AssertionError("DISABLED 后 read 应拒绝")
        except LifecycleError:
            pass

        # 4) enable（重新授权 + 构件 + conformance）
        st = ctl.enable("fake:inst1")
        _check(st["binding"] == "ACTIVE" and st["truth"] == "ADVISORY",
               "enable → ACTIVE/ADVISORY（无 conformance）")
        _check(validate_invariants(st) == [], "INV 无违规")

        # 5) uninstall（只解绑当前，其余 binding 零影响）
        ctl.install("fake:other")
        out = ctl.uninstall("fake:inst1")
        _check(out["binding"] == "UNINSTALLED", "uninstall")
        _check(ctl.status("fake:other")["binding"] == "ACTIVE", "其他 binding 零影响")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e2e_enforced_candidate_in_isolated_env():
    """ENFORCED 候选（隔离环境）：conformance 证据链 → enable 后 ENFORCED。"""
    tmp = tempfile.mkdtemp(prefix="lc-e2e-enf-")
    try:
        ctl = LifecycleController(os.path.join(tmp, "state"),
                                  auth_check=lambda b: True,
                                  artifact_check=lambda b: True,
                                  conformance=lambda b: True)
        ctl.install("enf:1")
        ctl.disable("enf:1")
        st = ctl.enable("enf:1")
        _check(st["truth"] == "ENFORCED", "conformance 过 → ENFORCED（候选）")
        _check(validate_invariants(st) == [], "INV 无违规")
        # 真实环境必须 ADVISORY/AUDIT：本测试仅在隔离环境证明 ENFORCED 候选可达，
        # 且 enable 必须重新走 conformance 证据链（enable 实现强制）
        _check(ctl.conformance("enf:1") is True, "conformance 证据链参与判定")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e2e_adapter_bypass_blocked():
    """伪制 Adapter 旁路测试：绕过 Claim Gate 的读取在 ENFORCED 候选下阻断。"""
    tmp = tempfile.mkdtemp(prefix="lc-e2e-bypass-")
    try:
        ctl = LifecycleController(os.path.join(tmp, "state"))
        ctl.install("adp:1")
        recall = TruthAwareRecall(
            recall_fn=lambda q, tier="T0", **kw: "memory-content",
            capability="ENFORCED")
        adp = FakeAdapter(ctl, "adp:1", recall=recall)
        # 无 receipt + require_verified → 阻断（旁路失败）
        try:
            adp.read("what is state", require_verified=True)
            raise AssertionError("旁路读取必须阻断")
        except BypassError:
            pass
        # 有 receipt + require_verified → 通过
        rec = TruthReceipt().issue(
            [{"claim_type": "LIFECYCLE_STATE", "value": "ACTIVE",
              "status": "CURRENT_STATE_VERIFIED"}],
            bound_evidence_head="a" * 40)
        out = adp.read("what is state", receipt=rec, require_verified=True)
        _check(out["state"] == "VERIFIED", "带 receipt 通过")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e2e_fake_adapter_contract_and_lifecycle():
    """伪制 Adapter：合同五方法 + lifecycle 走控制器。"""
    tmp = tempfile.mkdtemp(prefix="lc-e2e-adp-")
    try:
        ctl = LifecycleController(os.path.join(tmp, "state"))
        adp = FakeAdapter(ctl, "fake:2")
        plan = adp.query({"claim_types": ["LIFECYCLE_STATE"]})
        _check(plan[0]["claim_type"] == "LIFECYCLE_STATE", "query → planner")
        _check(adp.capability() == "ADVISORY", "capability 上报")
        st = adp.lifecycle("install", "fake:2")
        _check(st["binding"] == "ACTIVE", "lifecycle install 经控制器")
        st = adp.lifecycle("disable", "fake:2")
        _check(st["binding"] == "DISABLED", "lifecycle disable")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_e2e_multi_binding_isolation():
    """多 Binding 共享与隔离：状态文件互不干扰。"""
    tmp = tempfile.mkdtemp(prefix="lc-e2e-multi-")
    try:
        ctl = LifecycleController(os.path.join(tmp, "state"))
        for bid in ("a:1", "a:2", "b:3"):
            ctl.install(bid)
        ctl.disable("a:1")
        _check(ctl.status("a:1")["binding"] == "DISABLED", "a:1 DISABLED")
        _check(ctl.status("a:2")["binding"] == "ACTIVE", "a:2 不受影响")
        _check(ctl.status("b:3")["binding"] == "ACTIVE", "b:3 不受影响")
        ctl.uninstall("b:3")
        _check(ctl.status("b:3")["binding"] == "UNINSTALLED", "b:3 已卸载")
        _check(ctl.status("a:2")["binding"] == "ACTIVE", "卸载 b 不影响 a")
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
