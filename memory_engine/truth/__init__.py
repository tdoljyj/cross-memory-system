# -*- coding: utf-8 -*-
"""Truth Integrity 模块（R3-T01~T04 + Claim Gate 基础链路，ADR-R3-002）。

子模块：
- schema    ：claim types / fact kinds / reason codes 单一事实源
- planner   ：R3-T01 Truth Requirement Planner
- provider  ：R3-T02 Repository Truth Provider（现场核验，不依赖 refs/remotes 写）
- binder    ：R3-T03 Validation Evidence Binder（四 HEAD 绑定）
- receipt   ：R3-T04 Truth Receipt Issuer/Validator
- gate      ：Claim Gate 基础链路（fail-closed）

边界（Gate 1 裁决）：
- 本模块不触碰真实 memory/objects/**、index.json 与冻结区；
- 不把 Python 直写 refs/remotes/** 作为正式方案（provider 一律 ls-remote 现场取证）；
- ENFORCED 档位的 Adapter 接线属 Gate 2。
"""

from .schema import (
    CLAIM_TYPES, FACT_KINDS, DEFAULT_FACT_KIND, REASON_CODES,
    VERDICT_VERIFIED, VERDICT_UNVERIFIED, SOURCE_PRECEDENCE,
)
from .planner import TruthPlanner
from .provider import RepositoryTruthProvider, RepositoryTruthError
from .binder import EvidenceBinder, EvidenceBindingError
from .receipt import TruthReceipt, ReceiptError
from .gate import ClaimGate

__all__ = [
    "CLAIM_TYPES", "FACT_KINDS", "DEFAULT_FACT_KIND", "REASON_CODES",
    "VERDICT_VERIFIED", "VERDICT_UNVERIFIED", "SOURCE_PRECEDENCE",
    "TruthPlanner", "RepositoryTruthProvider", "RepositoryTruthError",
    "EvidenceBinder", "EvidenceBindingError",
    "TruthReceipt", "ReceiptError", "ClaimGate",
]
