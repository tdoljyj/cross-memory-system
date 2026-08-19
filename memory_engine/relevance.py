# -*- coding: utf-8 -*-
"""MIV-005A 相关性准入门（Relevance Admission）。

只增加一道「相关性准入」判定，不改候选生成、分词、评分权重或排序：
    scope / status / permission / temporal 硬过滤
        ↓
    现有 _match_score
        ↓
    现有 conflict / ranking
        ↓
    MIV-005A relevance admission
        ↓
    现有 limit / context packing

准入规则（冻结）：
    显式 tags/entities selector 命中  OR  score > 1/6
    - 比较必须为严格 >；score == 1/6 必须排除；
    - layers/categories 只是候选路由，不构成相关性证据；
    - 不允许按 case、类别或项目设置特殊阈值；
    - 不允许 synonym map、BM25、Embedding、tokenizer 改造或排序调权。

适用边界（Gate 2R 兼容合同，详见 ADR-MIV-005A-001）：
    - 显式 layers 的定向召回：准入门生效；
    - 空 query 且无显式 selector：任何 mode 一律 NO MEMORY；
    - MIV-006 硬隔离 mode（project_only / session_only / temporary）的
      非空查询不叠加准入门（可见性合同由 scope 硬过滤定义，保持既有
      295 项断言语义）；
    - 默认 tier→layer 映射的非空查询不叠加准入门（引擎内部路由合同，
      与 v2.0 既有行为一致）。

本模块无任何文件/网络副作用，只做纯判定，可独立单测。
"""

RELEVANCE_POLICY_VERSION = "1.0"

_THRESHOLD_NUMERATOR = 1
_THRESHOLD_DENOMINATOR = 6
# score > 1/6（严格大于）；等于 1/6 必须排除
RELEVANCE_THRESHOLD = 1.0 / 6.0
RELEVANCE_COMPARISON = "strict_greater_than"

# MIV-006 硬隔离 mode（非空查询不叠加准入门）
NEW_SCOPE_MODES = ("project_only", "session_only", "temporary")


def threshold_ref():
    """Trace 输出用：threshold 与比较方式（只读声明，不参与决策）。"""
    return {
        "value": "%d/%d" % (_THRESHOLD_NUMERATOR, _THRESHOLD_DENOMINATOR),
        "float": RELEVANCE_THRESHOLD,
        "comparison":
            "score > %d/%d (%s; score == %d/%d must be excluded)" % (
                _THRESHOLD_NUMERATOR, _THRESHOLD_DENOMINATOR,
                RELEVANCE_COMPARISON,
                _THRESHOLD_NUMERATOR, _THRESHOLD_DENOMINATOR),
        "selector_bypass": ["tags", "entities"],
        "layers_categories_not_relevance_evidence": True,
    }


def gate_active(query, layers_explicit, scope):
    """准入门是否作用于本次查询（threshold 本身对所有查询一致）。

    返回 True = 在 conflict 之后、limit 之前对准入候选做
    `admit()` 过滤；返回 False = 该查询路径不叠加准入门
    （Gate 2R 兼容边界，非阈值特例）。
    """
    query = query or ""
    if not query:
        # 空 query 且无显式 selector → NO MEMORY（无 selector 命中时
        # score=0 一律低于阈值，全部候选被排除）。
        return True
    if scope in NEW_SCOPE_MODES:
        return False
    return bool(layers_explicit)


def selector_hit(obj, tags=None, entities=None):
    """显式 tags/entities selector 是否命中该候选。

    引擎上游已对 selector 做硬过滤，能到达准入阶段的候选必然已命中；
    此处按对象独立判定，保持准入门可独立单测。
    """
    if tags and (set(tags) & set(obj.get("tags") or [])):
        return True
    if entities and (set(entities) & set(obj.get("entities") or [])):
        return True
    return False


def admit(obj, score, tags=None, entities=None):
    """准入判定：selector 命中 OR score 严格大于 1/6。"""
    if selector_hit(obj, tags, entities):
        return True
    return score > RELEVANCE_THRESHOLD
