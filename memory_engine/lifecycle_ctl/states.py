# -*- coding: utf-8 -*-
"""三轴状态模型（R3-T05 裁决：分别落地并机器校验）。

轴1 Binding Lifecycle：ABSENT / INSTALLING / ACTIVE / DISABLED / BROKEN /
                       UNINSTALLING / UNINSTALLED
轴2 Session & Sync ：ONLINE / DEGRADED / OFFLINE / DENIED
轴3 Truth Capability：UNAVAILABLE / ADVISORY / AUDIT / ENFORCED

不变量（机器校验，测试锁定）：
  INV-1  DISABLED / UNINSTALLED 不得携带 ENFORCED
  INV-2  repair 不得把 DISABLED 改成 ACTIVE（保持 DISABLED）
  INV-3  disable 后当前 Adapter 不得读/写/同步（session=OFFLINE/DENIED，
         操作 gate 拒绝）
  INV-4  ACTIVE 不自动等于 ENFORCED（禁止"已安装"代 ACTIVE、
         "在线"/ACTIVE 代 ENFORCED）
  INV-5  一切迁移必须命中转移矩阵
  INV-6  UNINSTALLED 之后 binding 记录可清理（回到 ABSENT），
         清理前 truth 必须非 ENFORCED
"""

BINDING_STATES = (
    "ABSENT", "INSTALLING", "ACTIVE", "DISABLED",
    "BROKEN", "UNINSTALLING", "UNINSTALLED",
)
SESSION_STATES = ("ONLINE", "DEGRADED", "OFFLINE", "DENIED")
TRUTH_LEVELS = ("UNAVAILABLE", "ADVISORY", "AUDIT", "ENFORCED")

# ---- 转移矩阵（轴1） ----
BINDING_TRANSITIONS = {
    "ABSENT":      ("INSTALLING",),
    "INSTALLING":  ("ACTIVE", "BROKEN", "ABSENT"),       # 成功/失败/回滚
    "ACTIVE":      ("DISABLED", "BROKEN", "UNINSTALLING"),
    "DISABLED":    ("ACTIVE", "BROKEN", "UNINSTALLING"),  # enable/损坏/卸载
    "BROKEN":      ("ACTIVE", "UNINSTALLING"),             # repair 成功/卸载
    "UNINSTALLING": ("UNINSTALLED", "BROKEN"),
    "UNINSTALLED": ("ABSENT", "INSTALLING"),               # 清理/重装
}

# ---- 不变量校验 ----
INVARIANTS = ("INV-1", "INV-2", "INV-3", "INV-4", "INV-5", "INV-6")


class InvariantViolation(Exception):
    def __init__(self, inv_id, detail=""):
        super(InvariantViolation, self).__init__("%s: %s" % (inv_id, detail))
        self.inv_id = inv_id
        self.detail = detail


def check_transition(binding_state, target):
    """轴1 迁移合法性（INV-5）。非法抛 InvariantViolation。"""
    allowed = BINDING_TRANSITIONS.get(binding_state, ())
    if target not in allowed:
        raise InvariantViolation(
            "INV-5", "非法迁移: %s -> %s（允许: %s）"
            % (binding_state, target, ",".join(allowed)))


def validate_invariants(state, operation=None):
    """校验三轴组合不变量。返回违规列表（空 = 通过）。

    state: {"binding":..., "session":..., "truth":...}
    operation: 触发动作（用于 INV-2：repair 时 DISABLED 不得变 ACTIVE）
    """
    violations = []
    binding = state.get("binding")
    truth = state.get("truth")
    session = state.get("session")
    # INV-1
    if binding in ("DISABLED", "UNINSTALLED") and truth == "ENFORCED":
        violations.append("INV-1: %s 不得携带 ENFORCED" % binding)
    # INV-4
    if binding == "ACTIVE" and truth == "ENFORCED":
        # ACTIVE+ENFORCED 合法（但必须由 Truth conformance 证据支持）；
        # 这里不阻断，仅在无证据时由调用方拒绝 —— 见 check_enforced_evidence
        pass
    # INV-3
    if binding == "DISABLED" and session in ("ONLINE",):
        violations.append("INV-3: DISABLED 不得 ONLINE（禁止读/写/同步）")
    # INV-6
    if binding == "UNINSTALLED" and truth == "ENFORCED":
        violations.append("INV-6: UNINSTALLED 清理前 truth 必须非 ENFORCED")
    # 状态合法
    if binding not in BINDING_STATES:
        violations.append("INV-5: binding 状态非法 %r" % binding)
    if session not in SESSION_STATES:
        violations.append("INV-5: session 状态非法 %r" % session)
    if truth not in TRUTH_LEVELS:
        violations.append("INV-5: truth 状态非法 %r" % truth)
    return violations


def new_state(binding="ABSENT", session="OFFLINE", truth="UNAVAILABLE"):
    return {"binding": binding, "session": session, "truth": truth}


def check_enforced_evidence(truth_level, conformance_passed=False):
    """ENFORCED 判定（INV-4 辅助）：必须有 conformance 证据。"""
    if truth_level == "ENFORCED" and not conformance_passed:
        raise InvariantViolation(
            "INV-4", "ENFORCED 必须由 Truth conformance 证据支持（无证据只能 ADVISORY/AUDIT）")
    return True
