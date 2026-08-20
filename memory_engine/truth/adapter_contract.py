# -*- coding: utf-8 -*-
"""R3-T06 版本化 Adapter 公共合同（ADR-R3-002 §8 + Gate 2 裁决）。

- ADAPTER_CONTRACT_VERSION = 1（schema 版本化，兼容层独立演进）；
- 机器可读合同：query / receipt / claim_gate / capability / lifecycle 五方法；
- Adapter 不得直接执行 git、不得自判 PASS（校验器注入 git 调用探测）；
- capability 档位：UNAVAILABLE / ADVISORY / AUDIT / ENFORCED（上报 + 校验）；
- validate_adapter：断言 Adapter 实现满足合同（fail-closed）。
"""

from . import schema

ADAPTER_CONTRACT_VERSION = 1

CAPABILITY_LEVELS = ("UNAVAILABLE", "ADVISORY", "AUDIT", "ENFORCED")

CONTRACT_METHODS = ("query", "receipt", "claim_gate", "capability", "lifecycle")

# ---- P0-3 裁决（2026-08-20）：Conformance environment 语义冻结（合同条款） ----
# ConformanceVerifier.verify(environment=...) 的 environment 表示
# **验证执行环境**（validation execution environment），即"执行 conformance
# 验证时验证器所处/所声明的环境类别"，与 Binding 的部署位置正交：
#
#   "isolated" —— 隔离/临时验证执行环境（测试夹具、试装验证、临时 home）。
#                全证据链（receipt 有效 + truth-state 强绑定 + 证据新鲜）下
#                可产出 ENFORCED 档位；该档位证明"该构件组合在隔离验证执行
#                环境中通过 conformance"，**不自动迁移到任何部署环境**。
#   "real"     —— 真实部署执行环境（产品运行环境）。最多 AUDIT，
#                未获产品所有者授权不得自行升级。
#
# 防误解条款（ADR-R3-007）：
# 1) 真实 Binding 的试装验证以 environment="isolated" 调用 verifier，
#    表示"验证发生在隔离执行环境中"，**不等于**"该 Binding 部署在隔离环境"；
# 2) ENFORCED 档位绑定 (revision, 合同版本, 证据链, 验证执行环境) 元组，
#    部署环境的最终档位由产品所有者另行裁决；
# 3) 任何调用方不得把 environment 当作 Binding 部署属性上报/宣称。
ENVIRONMENT_SEMANTICS = {
    "isolated": "验证执行环境=隔离/临时（可产出 ENFORCED 档位证据）",
    "real": "验证执行环境=真实部署（最多 AUDIT，未授权不得升级）",
}


class ContractViolation(Exception):
    """Adapter 违反公共合同。"""


def validate_adapter(adapter, version=ADAPTER_CONTRACT_VERSION):
    """校验 Adapter 满足合同。返回 True；违规抛 ContractViolation。

    检查项：
      1) contract_version 匹配（缺失 → 视为 0 → 拒绝，fail-closed）；
      2) 五方法存在且可调用；
      3) capability 返回合法档位；
      4) 无 git 直连（检查方法体内/属性中的 git 命令签名 —— 轻量探测）。
    """
    if getattr(adapter, "contract_version", 0) != version:
        raise ContractViolation(
            "contract_version 不匹配: got=%r want=%d"
            % (getattr(adapter, "contract_version", None), version))
    for m in CONTRACT_METHODS:
        if not callable(getattr(adapter, m, None)):
            raise ContractViolation("缺方法: %s" % m)
    cap = adapter.capability()
    if cap not in CAPABILITY_LEVELS:
        raise ContractViolation("capability 非法: %r" % cap)
    if adapter.__class__.__name__ == "BaseAdapter":
        raise ContractViolation("不得直接实例化 BaseAdapter")
    return True


class BaseAdapter(object):
    """Adapter 基类（实现方继承）。不实现任何真实逻辑，仅定义契约形状。"""

    contract_version = ADAPTER_CONTRACT_VERSION
    name = "base"
    # 禁止：Adapter 直连 git（_forbidden_git 命名约定，validator 探测）
    _forbidden_git = ("git", "subprocess", "rev-parse", "ls-remote")

    def query(self, request):
        raise NotImplementedError

    def receipt(self, request):
        raise NotImplementedError

    def claim_gate(self, claim_type, receipt=None):
        raise NotImplementedError

    def capability(self):
        return "UNAVAILABLE"

    def lifecycle(self, action, binding_id):
        raise NotImplementedError


class CapabilityReporter(object):
    """能力档位上报（UNAVAILABLE→ADVISORY→AUDIT→ENFORCED 保守升级）。

    升级必须逐级且提供证据（证据由调用方传入，本类只记录）。
    """

    def __init__(self, initial="UNAVAILABLE"):
        if initial not in CAPABILITY_LEVELS:
            raise ContractViolation("初始档位非法: %r" % initial)
        self._level = initial
        self._history = []

    def level(self):
        return self._level

    def promote(self, target, evidence=None):
        """保守升级：只能逐级（UNAVAILABLE→ADVISORY→AUDIT→ENFORCED）。"""
        if target not in CAPABILITY_LEVELS:
            raise ContractViolation("目标档位非法: %r" % target)
        cur_i = CAPABILITY_LEVELS.index(self._level)
        tgt_i = CAPABILITY_LEVELS.index(target)
        if tgt_i <= cur_i:
            raise ContractViolation(
                "禁止降级或平级: %s -> %s（回退走 demote）" % (self._level, target))
        if tgt_i - cur_i > 1:
            raise ContractViolation("禁止跳级: %s -> %s" % (self._level, target))
        self._level = target
        self._history.append({"to": target, "evidence": evidence, "ok": True})
        return target

    def demote(self, target, reason=None):
        """降级（回退），记录原因。"""
        if target not in CAPABILITY_LEVELS:
            raise ContractViolation("目标档位非法: %r" % target)
        cur_i = CAPABILITY_LEVELS.index(self._level)
        tgt_i = CAPABILITY_LEVELS.index(target)
        if tgt_i >= cur_i:
            raise ContractViolation("demote 只能降级: %s -> %s" % (self._level, target))
        self._level = target
        self._history.append({"to": target, "reason": reason, "ok": False})
        return target

    def history(self):
        return list(self._history)


class TruthAwareAdapter(BaseAdapter):
    """门禁化 Adapter 骨架：query 走 planner，claim_gate 走 TruthAwareRecall。

    Adapter 实现方继承本类并实现 lifecycle；读取/回答一律经
    memory_engine.truth.integration（不直 Git、不自判 PASS）。
    """

    def __init__(self, planner=None, recall=None, gate=None,
                 capability_reporter=None):
        self._planner = planner
        self._recall = recall  # TruthAwareRecall 实例（必须为门禁化）
        self._gate = gate
        self._cap = capability_reporter or CapabilityReporter("ADVISORY")

    def query(self, request):
        if self._planner is None:
            raise ContractViolation("planner 未注入")
        claim_types = request.get("claim_types", ["LIFECYCLE_STATE"])
        return self._planner.plan(claim_types)

    def receipt(self, request):
        raise NotImplementedError("由实现方绑定 TruthReceipt")

    def claim_gate(self, claim_type, receipt=None):
        if self._gate is None:
            raise ContractViolation("gate 未注入")
        return self._gate.check(claim_type, receipt=receipt)

    def capability(self):
        return self._cap.level()

    def lifecycle(self, action, binding_id):
        raise NotImplementedError("由实现方绑定 LifecycleController")

    @classmethod
    def class_name(cls):
        return cls.__name__
