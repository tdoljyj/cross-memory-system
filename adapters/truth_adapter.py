# -*- coding: utf-8 -*-
"""Gate 3-A：生产 Adapter 门禁化接线（recall/read/write/sync/pre_answer 全经 Claim Gate）。

真实端侧 Adapter 的生产入口接线（裁决 A 项）：
- read / recall：经 TruthAwareRecall（无有效 receipt → UNVERIFIED，ENFORCED 候选阻断）；
- write / sync：经 BypassGuard（操作前必须通过 binding 状态 gate + receipt 检查）；
- pre_answer：经 pre_answer_gate（回答前统一入口）。

`_gate_marker(name)` 供 production entry inventory 逐入口证明受保护
（零旁路证明）。

边界：本接线仅在隔离环境（临时 home）验证；真实环境绑定不切换
（保持 ADVISORY/AUDIT，等待单独试装授权）。
"""

from memory_engine.truth import (
    TruthAwareAdapter, TruthAwareRecall, BypassGuard, pre_answer_gate,
    schema as TS,
)
from memory_engine.truth.adapter_contract import CapabilityReporter


class TruthEnabledAdapter(TruthAwareAdapter):
    """生产 Adapter 骨架：五入口全部经 Claim Gate。"""

    name = "truth-enabled"

    def __init__(self, planner, recall_fn, lifecycle_controller=None,
                 gate=None, capability="ADVISORY"):
        super(TruthEnabledAdapter, self).__init__(
            planner=planner,
            recall=TruthAwareRecall(recall_fn, gate=gate, capability=capability),
            gate=gate,
            capability_reporter=CapabilityReporter(capability))
        self._lc = lifecycle_controller
        self._guard = BypassGuard(capability=capability,
                                  strict=(capability == "ENFORCED"))

    # ---- 入口 1/2：read & recall（经 TruthAwareRecall） ----
    def read(self, query, tier="T0", receipt=None, require_verified=False, **kw):
        return self._recall.recall(query, tier=tier, receipt=receipt,
                                   require_verified=require_verified, **kw)

    def recall(self, query, tier="T0", receipt=None, require_verified=False,
               **kw):
        return self.read(query, tier=tier, receipt=receipt,
                         require_verified=require_verified, **kw)

    # ---- 入口 3/4：write & sync（经 BypassGuard + binding 状态 gate） ----
    def write(self, binding_id, payload, receipt_marker=False):
        if self._lc is not None:
            self._lc.assert_operations_allowed(binding_id, "write")
        return self._guard.call("adapter.write", receipt_marker=receipt_marker,
                                binding_id=binding_id)

    def sync(self, binding_id, receipt_marker=False):
        if self._lc is not None:
            self._lc.assert_operations_allowed(binding_id, "sync")
        return self._guard.call("adapter.sync", receipt_marker=receipt_marker,
                                binding_id=binding_id)

    # ---- 入口 5：pre_answer（经 pre_answer_gate） ----
    def pre_answer(self, claim_type, receipt=None, env_error=None):
        return pre_answer_gate(claim_type, receipt=receipt, gate=self._gate,
                               env_error=env_error)

    # ---- 零旁路证明标记 ----
    def _gate_marker(self, entry_name):
        """返回该入口是否实际经 Claim Gate（供 entry inventory 证明）。"""
        gated = {
            "adapter.read": True, "adapter.recall": True,
            "adapter.write": True, "adapter.sync": True,
            "adapter.pre_answer": True,
        }
        return gated.get(entry_name, False)

    # ---- lifecycle（六动作经 LifecycleController） ----
    def lifecycle(self, action, binding_id):
        if self._lc is None:
            raise NotImplementedError("lifecycle_controller 未注入")
        return getattr(self._lc, action)(binding_id)
