# -*- coding: utf-8 -*-
"""Truth Integrity 模块（R3-T01~T06 + Gate 3 接线，ADR-R3-002）。

子模块：
- schema           ：claim types / fact kinds / reason codes / 回答状态单一事实源
- planner          ：R3-T01 Truth Requirement Planner
- provider         ：R3-T02 Repository Truth Provider（现场核验，不依赖 refs/remotes 写）
- binder           ：R3-T03 Validation Evidence Binder（四 HEAD 绑定）
- receipt          ：R3-T04 Truth Receipt Issuer/Validator
- gate             ：Claim Gate 基础链路（fail-closed）
- integration      ：R3-T05 Truth integration layer（状态区分 / pre-answer / 旁路检测）
- adapter_contract ：R3-T06 版本化 Adapter 公共合同
- truth_state      ：Gate 3-B .truth-state 强化存储（原子写/权限/强绑定/fail-closed）
- conformance      ：Gate 3-A/B ConformanceVerifier（外部生成最终能力档位）
- entry_inventory  ：Gate 3-A 生产入口清单与零旁路证明

边界（Gate 1/2/3 裁决）：
- 本模块不触碰真实 memory/objects/**、index.json 与冻结区；
- 不把 Python 直写 refs/remotes/** 作为正式方案（provider 一律 ls-remote 现场取证）；
- ENFORCED 仅限隔离环境临时 Binding；真实环境保持 ADVISORY/AUDIT（等待试装授权）；
- 仓库 revision/Adapter 实现最多 ENFORCED-CAPABLE。
"""

from .schema import (
    CLAIM_TYPES, FACT_KINDS, DEFAULT_FACT_KIND, REASON_CODES,
    VERDICT_VERIFIED, VERDICT_UNVERIFIED, SOURCE_PRECEDENCE,
    ANSWER_STATES,
)
from .planner import TruthPlanner
from .provider import RepositoryTruthProvider, RepositoryTruthError
from .binder import EvidenceBinder, EvidenceBindingError
from .receipt import TruthReceipt, ReceiptError
from .gate import ClaimGate
from .integration import (
    TruthAwareRecall, pre_answer_gate, classify_answer, BypassError, BypassGuard,
)
from .adapter_contract import (
    ADAPTER_CONTRACT_VERSION, CAPABILITY_LEVELS, CONTRACT_METHODS,
    ContractViolation, validate_adapter, BaseAdapter, CapabilityReporter,
    TruthAwareAdapter,
)
from .truth_state import TruthStateStore, TruthStateError
from .conformance import ConformanceVerifier, ConformanceError
from .entry_inventory import (
    PRODUCTION_ENTRIES, BypassFound, verify_zero_bypass,
    read_version_matrix, assert_version_matrix_consistent,
)

__all__ = [
    "CLAIM_TYPES", "FACT_KINDS", "DEFAULT_FACT_KIND", "REASON_CODES",
    "VERDICT_VERIFIED", "VERDICT_UNVERIFIED", "SOURCE_PRECEDENCE",
    "ANSWER_STATES",
    "TruthPlanner", "RepositoryTruthProvider", "RepositoryTruthError",
    "EvidenceBinder", "EvidenceBindingError",
    "TruthReceipt", "ReceiptError", "ClaimGate",
    "TruthAwareRecall", "pre_answer_gate", "classify_answer",
    "BypassError", "BypassGuard",
    "ADAPTER_CONTRACT_VERSION", "CAPABILITY_LEVELS", "CONTRACT_METHODS",
    "ContractViolation", "validate_adapter", "BaseAdapter",
    "CapabilityReporter", "TruthAwareAdapter",
    "TruthStateStore", "TruthStateError",
    "ConformanceVerifier", "ConformanceError",
    "PRODUCTION_ENTRIES", "BypassFound", "verify_zero_bypass",
    "read_version_matrix", "assert_version_matrix_consistent",
]
