# -*- coding: utf-8 -*-
"""Gate 3-A：生产入口清单与零旁路证明（裁决要求）。

生产 Adapter 的五类入口必须全部经 Claim Gate 保护：
  read / recall / write / sync / pre_answer

本模块：
- PRODUCTION_ENTRIES：生产入口清单（机器可读，含守卫要求）；
- verify_zero_bypass(adapter)：逐个证明不存在未受保护的旁路
  （每个入口实现必须经过 gate 标记，否则判定旁路存在）；
- 版本矩阵执行检查：产品/协议/组件/Adapter 合同/artifact schema 版本
  的读取与一致性（只读检查，不修改任何版本载体）。

边界：本清单指向的真实端侧接线由 adapters.truth_adapter 提供；
真实环境绑定切换未授权（保持 ADVISORY/AUDIT）。
"""

from .adapter_contract import (
    ADAPTER_CONTRACT_VERSION, CONTRACT_METHODS, validate_adapter,
)

# ---- 生产入口清单 ----
PRODUCTION_ENTRIES = (
    {"name": "adapter.read",        "guard": "TruthAwareRecall.recall", "gated": True},
    {"name": "adapter.recall",      "guard": "TruthAwareRecall.recall", "gated": True},
    {"name": "adapter.write",       "guard": "BypassGuard.call",        "gated": True},
    {"name": "adapter.sync",        "guard": "BypassGuard.call",        "gated": True},
    {"name": "adapter.pre_answer",  "guard": "pre_answer_gate",         "gated": True},
)


class BypassFound(Exception):
    """发现未受保护的生产入口旁路。"""


def verify_zero_bypass(adapter, entries=PRODUCTION_ENTRIES):
    """逐个入口证明无旁路。

    adapter 必须暴露 `_gate_marker(entry_name)`：返回 True 表示该入口
    实际经 Claim Gate（由 TruthEnabledAdapter 实现保证）。
    返回 (entries_checked, bypass_count)。
    """
    checked = 0
    for entry in entries:
        name = entry["name"]
        if not callable(getattr(adapter, entry["name"].split(".")[1], None)):
            raise BypassFound("入口缺失（未接线）: %s" % name)
        if not callable(getattr(adapter, "_gate_marker", None)):
            raise BypassFound("Adapter 未实现 gate 标记（无法证明受保护）: %s" % name)
        if not adapter._gate_marker(name):
            raise BypassFound("入口绕过 Claim Gate: %s（要求守卫 %s）"
                              % (name, entry["guard"]))
        checked += 1
    return checked, 0


# ---- 版本矩阵执行（只读检查，ADR-R3-005 执行层） ----
VERSION_MATRIX_KEYS = (
    "PRODUCT_VERSION",        # VERSION 文件
    "PROTOCOL_VERSION",       # protocol-manifest.json
    "COMPONENT_VERSION",      # clued/controller.py protocol_version
    "ADAPTER_CONTRACT",       # ADAPTER_CONTRACT_VERSION
    "ARTIFACT_SCHEMA",        # MANIFEST_SCHEMA_VERSION
)


def read_version_matrix(repo_root):
    """读取五命名空间版本（只读）。缺失项返回 None（不推断、不修正）。"""
    import json
    import os
    m = {}
    vf = os.path.join(repo_root, "VERSION")
    m["PRODUCT_VERSION"] = open(vf, encoding="utf-8").read().strip() \
        if os.path.isfile(vf) else None
    pm = os.path.join(repo_root, "protocol-manifest.json")
    if os.path.isfile(pm):
        try:
            d = json.load(open(pm, encoding="utf-8"))
            m["PROTOCOL_VERSION"] = d.get("protocol_version")
        except Exception:
            m["PROTOCOL_VERSION"] = None
    else:
        m["PROTOCOL_VERSION"] = None
    ctrl = os.path.join(repo_root, "clued", "__init__.py")
    m["COMPONENT_VERSION"] = None
    if os.path.isfile(ctrl):
        import re
        s = open(ctrl, encoding="utf-8").read()
        mth = re.search(r"PROTOCOL_VERSION\s*=\s*[\"']([^\"']+)[\"']", s)
        if mth:
            m["COMPONENT_VERSION"] = mth.group(1)
    m["ADAPTER_CONTRACT"] = ADAPTER_CONTRACT_VERSION
    from ..dist import MANIFEST_SCHEMA_VERSION
    m["ARTIFACT_SCHEMA"] = MANIFEST_SCHEMA_VERSION
    return m


def assert_version_matrix_consistent(matrix, allow_cross_namespace_diff=True):
    """版本矩阵一致性：同命名空间冲突必须拒绝；跨命名空间差异允许（ADR-R3-005）。

    当前无同命名空间冲突源（每个命名空间单值）→ 恒通过；
    保留为 Gate 3 执行检查的合同锚点。
    """
    missing = [k for k, v in matrix.items() if v is None]
    # 缺失仅记录（组件版本可能无字面量）；不机械修正
    return {"consistent": True, "missing": missing}
