# -*- coding: utf-8 -*-
"""Memory Recall Engine（Phase 5）：T0–T4 → L1–L6 → 确定性混合召回。

流程（§10）：
    Query → T0–T4 Router（AI 判定，引擎只消费 tier）
    → L1–L6 coarse routing（memory/index.json 的 Markdown 段级映射 + 对象类别）
    → Candidate retrieval → Metadata filtering → Temporal validity
    → Status filtering → Conflict filtering → Relevance ranking
    → Context packing

v2.0 第一阶段：确定性召回（exact/keyword/category/tag/entity/temporal/
status/priority），**不使用向量数据库 / embedding / 外部 SaaS**（§10/§18）。

硬约束（§17）：
- T0 必须真正零读取：任何文件（含 index.json / objects）都不得触碰
- 任何时候不得因引擎存在而全量加载 memory objects
"""

import json
import os

from . import conflict
from . import object_index
from . import paths
from . import schema as S
from . import store
from . import temporal as T

ACCESS_BY_LAYER = {
    "L1": "IDENTITY",
    "L2": "PREFERENCE",
    "L3": "PROJECT",
    "L4": "HISTORY",
    "L5": "CONSTRAINT",
}


class RecallResult(object):
    def __init__(self):
        self.access = "NONE"
        self.tier = "T0"
        self.layers = []
        self.markdown_plan = []
        self.objects = []
        self.constraints = []
        self.query = ""
        self.skipped = {"superseded": 0, "expired": 0, "conflict_loser": 0}
        self.warnings = []

    def to_dict(self):
        return {
            "access": self.access,
            "tier": self.tier,
            "layers": self.layers,
            "query": self.query,
            "markdown_plan": self.markdown_plan,
            "objects": self.objects,
            "constraints": self.constraints,
            "count": len(self.objects),
            "skipped": self.skipped,
            "warnings": self.warnings,
        }


def _access_name(layers):
    names = {ACCESS_BY_LAYER.get(l) for l in layers if l in ACCESS_BY_LAYER}
    names.discard(None)
    if not names:
        return "NONE"
    if len(names) == 1:
        return names.pop()
    return "MULTI"


def load_markdown_plan(layers):
    """读 memory/index.json 的 L1–L6 段级映射（Markdown 召回计划）。"""
    if not layers:
        return []
    idx_path = paths.RECALL_INDEX_PATH
    if not os.path.isfile(idx_path):
        return []
    try:
        with open(idx_path, "r", encoding="utf-8") as fh:
            idx = json.load(fh)
    except Exception:
        return []
    recall_map = idx.get("recall") or {}
    plan = []
    for layer in layers:
        for entry in recall_map.get(layer) or []:
            plan.append({
                "layer": layer,
                "file": entry.get("file"),
                "sections": list(entry.get("sections") or []),
            })
    return plan


def _category_scope_ok(obj, categories, scope):
    if scope and scope != "global" and obj.get("scope") not in ("global", scope):
        return False
    if scope and scope == "global" and obj.get("scope") != "global":
        return False
    if categories:
        cat = (obj.get("classification") or {}).get("category")
        if cat not in categories:
            return False
    return True


def _match_score(query, obj):
    """确定性相关性：实体/标签精确命中 > 关键词重合 > 类别命中。"""
    if not query:
        return 0.0
    q_tokens = conflict.tokenize(query)
    if not q_tokens:
        return 0.0
    content_tokens = conflict.tokenize(obj.get("content"))
    overlap = len(q_tokens & content_tokens)
    keyword = overlap / max(1.0, len(q_tokens))
    tags = set(obj.get("tags") or [])
    entities = set(obj.get("entities") or [])
    exact = 0.0
    for t in tags | entities:
        if t and t in query:
            exact += 1.5
    cat = (obj.get("classification") or {}).get("category") or ""
    cat_bonus = 1.0 if cat and cat in query else 0.0
    return keyword + exact + cat_bonus


def _rank_key(obj, score):
    cls = obj.get("classification") or {}
    prov = obj.get("provenance") or {}
    src = obj.get("source") or {}
    return (
        score,
        S.PRIORITY_WEIGHT.get(cls.get("priority"), 0),
        S.EVIDENCE_PRIORITY.get(prov.get("evidence"), 0),
        src.get("updated_at") or "",
    )


def _conflict_filter(objects):
    """冲突过滤（§10）：active 对象对中裁决输家不返回。

    A.supersedes B / A.contradicts B → B 是输家（若 B 也在返回集）。
    裁决以 evidence 优先级 + 时间戳，与 conflict.evidence_wins 一致。
    """
    by_id = {o["id"]: o for o in objects}
    losers = set()
    for obj in objects:
        rel = obj.get("relations") or {}
        for other_id in list(rel.get("supersedes") or []) + \
                list(rel.get("contradicts") or []):
            other = by_id.get(other_id)
            if not other or other_id in losers:
                continue
            ev_a = (obj.get("provenance") or {}).get("evidence")
            ev_b = (other.get("provenance") or {}).get("evidence")
            t_a = (obj.get("source") or {}).get("updated_at")
            t_b = (other.get("source") or {}).get("updated_at")
            if conflict.evidence_wins(ev_a, t_a, ev_b, t_b):
                losers.add(other_id)
            else:
                losers.add(obj["id"])
    return [o for o in objects if o["id"] not in losers], losers


def _attach_constraints(objects, all_objects):
    """§8.D：返回集实体的约束/负向偏好附带（供推荐过滤用）。"""
    wanted_entities = set()
    for o in objects:
        wanted_entities |= set(o.get("entities") or [])
        wanted_entities |= set(o.get("tags") or [])
    if not wanted_entities:
        return []
    constraints = []
    seen = set()
    for o in all_objects:
        cat = (o.get("classification") or {}).get("category")
        if cat not in ("constraint", "negative_preference"):
            continue
        if not T.active_and_valid(o):
            continue
        ents = set(o.get("entities") or []) | set(o.get("tags") or [])
        if ents & wanted_entities and o["id"] not in seen:
            constraints.append(o)
            seen.add(o["id"])
    return constraints


def recall(query="", tier="T0", layers=None, scope=None, include_history=False,
           categories=None, tags=None, entities=None, limit=10,
           valid_at=None, light=None, max_objects=200):
    """确定性混合召回入口。

    返回 RecallResult。T0 = 零文件读取纯短路（§17）。
    """
    result = RecallResult()
    result.query = query or ""
    tier = (tier or "T0").upper()
    if tier not in S.TIER_LAYERS:
        raise ValueError("未知 tier: %s" % tier)
    result.tier = tier

    # ---- T0：真正零读取（不碰 index.json / objects / 任何文件）----
    if tier == "T0":
        result.access = "NONE"
        return result

    if tier == "T4":
        # 明确记忆指令走 Write Engine；召回侧返回提示语义
        result.access = "IMMEDIATE_WRITE"
        result.warnings.append("T4 = 立即写入（走 Write Engine），不触发召回")
        return result

    if layers is None:
        layers = list(S.TIER_LAYERS.get(tier, []))
    layers = [l for l in layers if l in S.RECALL_LAYERS]
    result.layers = layers
    result.access = _access_name(layers)

    if light is None:
        light = (tier == "T3")
    if light:
        limit = min(limit, 3)

    result.markdown_plan = load_markdown_plan(layers)

    want_categories = list(categories or [])
    if not want_categories:
        for l in layers:
            want_categories.extend(S.LAYER_CATEGORIES.get(l, []))
    if not want_categories:
        return result  # 无对象召回需求（如 L6）

    objects = store.load_all_objects()
    if len(objects) > max_objects:
        result.warnings.append(
            "对象数 %d 超过召回上限 %d，已截断（禁止全量加载）"
            % (len(objects), max_objects))
        objects = objects[:max_objects]

    statuses = set(S.RECALLABLE_STATUSES)
    if include_history:
        statuses |= set(S.HISTORY_STATUSES)

    filtered = []
    for obj in objects:
        if obj.get("status") not in statuses:
            if obj.get("status") in ("superseded", "archived"):
                result.skipped["superseded"] += 1
            continue
        if not _category_scope_ok(obj, want_categories, scope):
            continue
        # 时间过滤只约束「当前」召回；历史查询（superseded/archived/expired，
        # 或已过 valid_until 的 active 对象）不受影响（CURRENT vs HISTORY，§11）
        expired_now = T.is_expired(obj, valid_at)
        is_history = include_history and (
            obj.get("status") in S.HISTORY_STATUSES or expired_now)
        if not is_history and not T.is_valid_now(obj, valid_at):
            if expired_now:
                result.skipped["expired"] += 1
            continue
        if tags and not (set(tags) & set(obj.get("tags") or [])):
            continue
        if entities and not (set(entities) & set(obj.get("entities") or [])):
            continue
        if light and (obj.get("classification") or {}).get("priority") != "high":
            continue
        filtered.append(obj)

    ranked = sorted(
        filtered,
        key=lambda o: _rank_key(o, _match_score(result.query, o)),
        reverse=True)
    # 冲突过滤只约束「当前」召回（竞争事实只保留胜者）；历史查询返回全部版本
    if include_history:
        survivors, losers = ranked, set()
    else:
        survivors, losers = _conflict_filter(ranked)
    result.skipped["conflict_loser"] = len(losers)
    result.objects = survivors[:limit]
    result.constraints = _attach_constraints(result.objects, objects)
    return result


def recall_status_summary():
    """memory.py status 用：对象库统计（各状态/类别计数）。"""
    objects = store.load_all_objects(include_invalid=True)
    summary = {"total": len(objects), "by_status": {}, "by_category": {}}
    for o in objects:
        st = o.get("status") or "invalid"
        cat = (o.get("classification") or {}).get("category") or "invalid"
        summary["by_status"][st] = summary["by_status"].get(st, 0) + 1
        summary["by_category"][cat] = summary["by_category"].get(cat, 0) + 1
    idx = object_index.load_index()
    summary["index"] = "present" if idx else "missing"
    if idx:
        summary["index_count"] = len(idx.get("objects") or {})
    return summary
