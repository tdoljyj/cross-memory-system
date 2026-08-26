# -*- coding: utf-8 -*-
"""Lifecycle Controller 模块（R3-L01~L05 + 三轴状态，Gate 2）。

- states    ：三轴状态模型 + 不变量（INV-1..6）+ 转移矩阵
- controller：LifecycleController 六动作（install/repair/update/disable/enable/uninstall）
              + 幂等 + 中断恢复 + 操作 gate

边界（Gate 2 裁决）：临时 home / 临时仓库 / 伪制 Adapter 中验证；
不触碰真实 memory、冻结区、refs/remotes；真实环境保持 ADVISORY/AUDIT，
ENFORCED 候选验证仅限隔离环境。
"""

from .states import (
    BINDING_STATES, SESSION_STATES, TRUTH_LEVELS,
    BINDING_TRANSITIONS, INVARIANTS,
    InvariantViolation, check_transition, validate_invariants,
    new_state, check_enforced_evidence,
)
from .controller import LifecycleController, LifecycleError, ACTIONS

__all__ = [
    "BINDING_STATES", "SESSION_STATES", "TRUTH_LEVELS",
    "BINDING_TRANSITIONS", "INVARIANTS",
    "InvariantViolation", "check_transition", "validate_invariants",
    "new_state", "check_enforced_evidence",
    "LifecycleController", "LifecycleError", "ACTIONS",
]
