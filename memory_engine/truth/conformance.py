# -*- coding: utf-8 -*-
"""Gate 3-A/B：ConformanceVerifier —— 外部生成最终能力档位。

裁决要求：
- Adapter 的 CapabilityReporter 只能提供**声明**，不能自行决定 ENFORCED；
- 最终能力档位必须由**外部 conformance 验证器**根据绑定 revision、合同版本
  和证据生成；
- conformance 证据过期 → 降级；.truth-state 缺失/损坏/替换 → fail-closed；
- 分层结论：仓库 revision/Adapter 实现 → ENFORCED-CAPABLE；
  临时 home 通过 conformance 的测试 Binding → ENFORCED；
  真实环境 Binding → 继续 ADVISORY/AUDIT。
"""

import time

from .adapter_contract import CAPABILITY_LEVELS
from .truth_state import TruthStateStore, TruthStateError
from .receipt import ReceiptError, TruthReceipt


class ConformanceError(Exception):
    """conformance 验证失败（原因码）。"""


class ConformanceVerifier(object):

    def __init__(self, truth_state_store=None, max_evidence_age_seconds=3600,
                 receipt_validator=None):
        self.store = truth_state_store or TruthStateStore(".truth-state")
        self.max_evidence_age = max_evidence_age_seconds
        self.receipt = receipt_validator or TruthReceipt()

    # ---- 档位判定（唯一真值来源链：binding+receipt+evidence+truth-state） ----
    def verify(self, adapter, binding_id, revision, receipt=None,
               conformance_evidence=None, environment="isolated",
               now=None):
        """生成最终档位。返回 (capability, evidence_summary)。

        adapter：标识字符串（推荐）或实例（取 name/class_name；capability() 读声明）。
        environment="isolated"（临时 home）：可到 ENFORCED；
        environment="real"（真实用户环境）：最多 ADVISORY/AUDIT（未授权切换）。
        """
        now = now if now is not None else time.time()
        summary = []
        # adapter 标识归一化（实例 → name/class_name）
        if isinstance(adapter, str):
            adapter_name = adapter
            claim = "UNAVAILABLE"
        else:
            adapter_name = (getattr(adapter, "name", None)
                            or adapter.__class__.__name__)
            claim = adapter.capability() if hasattr(adapter, "capability") \
                else "UNAVAILABLE"

        # 1) receipt 必须有效（缺失/过期/篡改 → 降级）
        receipt_ok = False
        if receipt is not None:
            try:
                self.receipt.validate(receipt, max_age_seconds=self.max_evidence_age,
                                      now=now)
                receipt_ok = True
            except ReceiptError as e:
                summary.append("receipt 无效: %s" % e.reason)
        else:
            summary.append("无 receipt")

        # 2) .truth-state 强绑定（缺失/损坏/替换 → fail-closed 降级）
        state_ok = False
        if conformance_evidence is not None:
            try:
                self.store.verify_binding(
                    binding_id, adapter_name, revision, conformance_evidence)
                state_ok = True
            except TruthStateError as e:
                summary.append("truth-state 绑定失败: %s" % e.reason)
        else:
            summary.append("无 conformance evidence")

        # 3) 证据新鲜度
        evidence_fresh = True
        if state_ok:
            data = self.store.read(binding_id)
            meta = data.get("evidence_meta", {})
            ts = meta.get("verified_at")
            if ts is not None and (now - float(ts)) > self.max_evidence_age:
                evidence_fresh = False
                summary.append("conformance 证据过期")

        # 4) 声明 vs 实际（恶意自报降级）
        if claim not in CAPABILITY_LEVELS:
            claim = "UNAVAILABLE"

        # ---- 分层判定 ----
        if not receipt_ok or not state_ok or not evidence_fresh:
            capability = "ADVISORY"   # 真实与隔离：证据链不全一律降级
        elif environment == "real":
            capability = "AUDIT"      # 真实环境未授权 → 最多 AUDIT
        else:
            capability = "ENFORCED"   # 隔离 + 全证据链 → 临时 Binding ENFORCED

        # 恶意自报：声明 ENFORCED 但实际证据不足 → 实际档位为准（已由上面判定）
        summary.append("声明=%s → 最终=%s" % (claim, capability))
        return capability, "; ".join(summary)

    # ---- ENFORCED-CAPABLE（仓库 revision / Adapter 实现） ----
    def classify_implementation(self, adapter, contract_version, conformance_ok):
        """仓库 revision / Adapter 实现的结论：ENFORCED-CAPABLE 或未达标。

        conformance_ok：全部 fault-injection 场景通过 + 无旁路 + 入口清单闭合。
        """
        if conformance_ok and contract_version == 1:
            return "ENFORCED-CAPABLE"
        return "ADVISORY-CAPABLE"
