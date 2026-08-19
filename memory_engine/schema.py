# -*- coding: utf-8 -*-
"""Memory Object Schema v1（vNext-2.0）。

字段语义与枚举：
- id           ：mem_ + 8~16 位小写字母/数字（全局唯一，幂等锚点）
- type         ：Memory Function Type（认知层）——foundational / semantic / episodic /
                 procedural / state / temporary（执行计划 §5；§4 示例中的 type="preference"
                 与 §5 冲突，本实现以 §5 为准，内容类别归入 classification.category）
- scope        ：global / project / session / agent / machine（§14；§4 示例 "user" 视为占位）
- status       ：生命周期（§6）：candidate / active / reinforced / superseded / archived /
                 rejected / expired / deprecated
- content      ：记忆正文（唯一文本承载）
- source       ：来源元数据（kind / adapter / session_id / created_at / updated_at）
- temporal     ：valid_from / valid_until（§11 时间记忆）
- relations    ：supersedes / superseded_by / contradicts / related（§6/§9 历史关系）
- classification：memory_layer / category / recall_layer / priority（§5 双维度分离）
- provenance   ：evidence ∈ {explicit, observed, inferred}（§4，优先级 explicit > observed > inferred）
- tags / entities：确定性召回用的结构化标签与实体（§10）

枚举优先级（§9）：用户当前明确表达 > 用户历史明确表达 > 用户长期稳定偏好 >
用户实际行为 > AI inference。数值化 confidence 不在 v2.0 第一阶段（§4 禁止）。
"""

import re
from datetime import datetime

SCHEMA_VERSION = 1

# ---- 枚举（单一事实源，doctor/validator/引擎共用） ----
STATUSES = [
    "candidate", "active", "reinforced",
    "superseded", "archived", "rejected", "expired", "deprecated",
]
# 默认召回可见的状态（§6.9：retrieval 默认不返回 superseded）
RECALLABLE_STATUSES = ["active", "reinforced"]
# history 查询额外可见（§6.10 / §11 CURRENT vs HISTORY）
HISTORY_STATUSES = ["superseded", "archived", "expired", "deprecated"]

FUNCTION_TYPES = [
    "foundational", "semantic", "episodic", "procedural", "state", "temporary",
]

SCOPES = ["global", "project", "session", "agent", "machine"]
# 第一阶段真正参与逻辑的 scope（§14）；agent/machine 仅 metadata
ACTIVE_SCOPES = ["global", "project", "session"]

EVIDENCES = ["explicit", "observed", "inferred"]
EVIDENCE_PRIORITY = {"explicit": 3, "observed": 2, "inferred": 1}

PRIORITIES = ["high", "medium", "low"]
PRIORITY_WEIGHT = {"high": 3, "medium": 2, "low": 1}

SOURCE_KINDS = [
    "user_explicit", "user_implicit", "observed",
    "ai_inferred", "migration", "system", "unknown",
]

RECALL_LAYERS = ["L1", "L2", "L3", "L4", "L5", "L6"]

CATEGORIES = [
    "identity",            # L1 身份
    "preference",          # L2 偏好
    "negative_preference", # §8.D 否决/负向偏好（constraint 类）
    "project",             # L3 项目
    "state",               # L3 当前状态
    "decision",            # L3/L5 决策
    "history",             # L4 历史
    "event",               # L4 事件（episodic）
    "constraint",          # L5 约束（禁止项/兼容要求/预算）
    "workflow",            # L8 工作流程（procedural）
    "toolchain",           # L8 工具链（procedural）
    "method",              # L8 已验证方法（procedural）
    "todo",                # 待办（多为临时，谨慎入库）
    "other",
]

# T 级 → L 层（Router 输出为 AI 判定，引擎只做映射；§5：L1-L6 保持 Recall Routing）
TIER_LAYERS = {
    "T0": [],
    "T1": ["L1"],
    "T2": ["L3"],
    "T3": ["L3"],
    "T4": [],
}

# L 层 → 内容类别（对象召回粗路由；Markdown 段级路由仍以 memory/index.json 为准）
LAYER_CATEGORIES = {
    "L1": ["identity"],
    "L2": ["preference"],
    "L3": ["project", "state", "decision"],
    "L4": ["history", "event"],
    "L5": ["constraint", "negative_preference"],
    "L6": [],
}

_ID_RE = re.compile(r"^mem_[0-9a-z]{8,16}$")
_TS_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$")


def now_iso():
    """UTC ISO-8601 秒级时间戳（Z 后缀）。"""
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value):
    """解析时间戳为可比较的 datetime；无法解析返回 None。

    一律归一化为 UTC-aware（naive 输入按 UTC 解释），保证跨来源比较安全。
    """
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        from datetime import timezone
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def default_status_for(evidence, explicit_remember=False):
    """新记忆初始状态（§6.1/§6.4）：
    T4 明确记住或用户明确表达 → active；observed / inferred → candidate
    （inferred 不得直接升级为长期事实）。"""
    if explicit_remember or evidence == "explicit":
        return "active"
    return "candidate"


def validate_timestamp(value, allow_null=True):
    if value is None and allow_null:
        return None
    if not isinstance(value, str) or not _TS_RE.match(value):
        return "非法时间戳: %r" % (value,)
    if parse_ts(value) is None:
        return "时间戳无法解析: %r" % (value,)
    return None


def validate_object(obj):
    """校验一个 Memory Object。返回 (ok, errors)。

    doctor 的 object schema validation / invalid status / invalid scope /
    invalid memory type / invalid evidence / invalid temporal range 都以此为准。
    """
    errors = []
    if not isinstance(obj, dict):
        return False, ["对象必须是 JSON object"]

    def err(msg):
        errors.append(msg)

    if obj.get("schema_version") != SCHEMA_VERSION:
        err("schema_version 必须为 %d" % SCHEMA_VERSION)
    oid = obj.get("id")
    if not isinstance(oid, str) or not _ID_RE.match(oid):
        err("id 非法（须 mem_ + 8~16 位小写 hex）: %r" % (oid,))
    if obj.get("type") not in FUNCTION_TYPES:
        err("type 不在 Memory Function Type 枚举: %r" % (obj.get("type"),))
    if obj.get("scope") not in SCOPES:
        err("scope 不在枚举: %r" % (obj.get("scope"),))
    # MIV-006（ADR-MIV-006-001 D1）：可选 project_id（null 或非空字符串）。
    # 仅 scope=="project" 时参与召回硬过滤；缺失视为 null（legacy 语义）。
    pid = obj.get("project_id")
    if pid is not None and (not isinstance(pid, str) or not pid.strip()):
        err("project_id 必须为 null 或非空字符串: %r" % (pid,))
    if obj.get("status") not in STATUSES:
        err("status 不在枚举: %r" % (obj.get("status"),))
    content = obj.get("content")
    if not isinstance(content, str) or not content.strip():
        err("content 必须为非空字符串")

    src = obj.get("source")
    if not isinstance(src, dict):
        err("source 必须是 object")
    else:
        if src.get("kind") not in SOURCE_KINDS:
            err("source.kind 不在枚举: %r" % (src.get("kind"),))
        for key in ("adapter", "session_id"):
            v = src.get(key)
            if v is not None and not isinstance(v, str):
                err("source.%s 必须为字符串或 null" % key)
        for key in ("created_at", "updated_at"):
            e = validate_timestamp(src.get(key), allow_null=False)
            if e:
                err("source.%s %s" % (key, e))
        c = parse_ts(src.get("created_at"))
        u = parse_ts(src.get("updated_at"))
        if c and u and u < c:
            err("source.updated_at 早于 created_at")

    temporal = obj.get("temporal")
    if not isinstance(temporal, dict):
        err("temporal 必须是 object")
    else:
        for key in ("valid_from", "valid_until"):
            e = validate_timestamp(temporal.get(key), allow_null=True)
            if e:
                err("temporal.%s %s" % (key, e))
        vf = parse_ts(temporal.get("valid_from"))
        vu = parse_ts(temporal.get("valid_until"))
        if vf and vu and vu < vf:
            err("temporal 范围非法: valid_until 早于 valid_from")

    rel = obj.get("relations")
    if not isinstance(rel, dict):
        err("relations 必须是 object")
    else:
        for key in ("supersedes", "superseded_by", "contradicts", "related"):
            vals = rel.get(key)
            if not isinstance(vals, list) or not all(
                    isinstance(v, str) for v in vals):
                err("relations.%s 必须是字符串数组" % key)

    cls = obj.get("classification")
    if not isinstance(cls, dict):
        err("classification 必须是 object")
    else:
        layer = cls.get("memory_layer")
        if layer is not None and layer not in FUNCTION_TYPES:
            err("classification.memory_layer 不在枚举: %r" % (layer,))
        cat = cls.get("category")
        if cat not in CATEGORIES:
            err("classification.category 不在枚举: %r" % (cat,))
        if cls.get("priority") not in PRIORITIES:
            err("classification.priority 不在枚举: %r" % (cls.get("priority"),))
        rl = cls.get("recall_layer")
        if rl is not None and rl not in RECALL_LAYERS:
            err("classification.recall_layer 不在 L1-L6: %r" % (rl,))

    prov = obj.get("provenance")
    if not isinstance(prov, dict):
        err("provenance 必须是 object")
    else:
        if prov.get("evidence") not in EVIDENCES:
            err("provenance.evidence 不在枚举: %r" % (prov.get("evidence"),))
        ref = prov.get("source_ref")
        if ref is not None and not isinstance(ref, str):
            err("provenance.source_ref 必须为字符串或 null")

    for key in ("tags", "entities"):
        vals = obj.get(key)
        if vals is not None and (not isinstance(vals, list) or not all(
                isinstance(v, str) for v in vals)):
            err("%s 必须为字符串数组" % key)

    return (len(errors) == 0), errors


def new_object(oid, type_, content, scope="global", status=None,
               category="other", evidence="observed", priority="medium",
               recall_layer=None, adapter="memory-engine", session_id=None,
               valid_from=None, valid_until=None, tags=None, entities=None,
               source_kind=None, source_ref=None, supersedes=None,
               superseded_by=None, contradicts=None, related=None,
               created_at=None, project_id=None):
    """构造一个完整合法的 Memory Object 模板。

    status=None 时按证据默认（explicit → active；observed/inferred → candidate）。
    project_id（MIV-006）：仅 scope=="project" 时参与召回硬过滤；
    为 None 时对象 JSON 不携带该键（与 v2.0 输出字节兼容）。
    """
    now = created_at or now_iso()
    if status is None:
        status = default_status_for(evidence)
    if source_kind is None:
        source_kind = ("user_explicit" if evidence == "explicit" else
                       "ai_inferred" if evidence == "inferred" else "observed")
    obj = {
        "schema_version": SCHEMA_VERSION,
        "id": oid,
        "type": type_,
        "scope": scope,
        "content": content,
        "status": status,
        "source": {
            "kind": source_kind,
            "adapter": adapter,
            "session_id": session_id,
            "created_at": now,
            "updated_at": now,
        },
        "temporal": {
            "valid_from": valid_from,
            "valid_until": valid_until,
        },
        "relations": {
            "supersedes": supersedes or [],
            "superseded_by": superseded_by or [],
            "contradicts": contradicts or [],
            "related": related or [],
        },
        "classification": {
            "memory_layer": type_,
            "category": category,
            "recall_layer": recall_layer,
            "priority": priority,
        },
        "provenance": {
            "evidence": evidence,
            "source_ref": source_ref,
        },
        "tags": tags or [],
        "entities": entities or [],
    }
    if project_id is not None:
        obj["project_id"] = project_id
    return obj
