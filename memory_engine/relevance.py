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

适用范围（MIV-005A-R1 勘误，取代旧「显式 layers 才生效」边界）：
    - 到达准入阶段的所有召回路由统一生效、规则与阈值完全一致：
      显式 layers 定向召回、默认 tier→layer 映射、MIV-006 硬隔离 mode
      （project_only / session_only）；
    - 空 query 且无显式 selector：任何路由一律 NO MEMORY；
    - T0 / T4 / temporary 在准入阶段之前提前短路（零读取），不进入本判定；
    - 顺序保持已接受的合同修正：conflict 之后、limit 之前
      （conflict loser 永远保持 CONFLICT_LOSER，不会因 winner 被过滤而复活）。

本模块无任何文件/网络副作用，只做纯判定，可独立单测。
"""

RELEVANCE_POLICY_VERSION = "1.0"

_THRESHOLD_NUMERATOR = 1
_THRESHOLD_DENOMINATOR = 6
# score > 1/6（严格大于）；等于 1/6 必须排除
RELEVANCE_THRESHOLD = 1.0 / 6.0
RELEVANCE_COMPARISON = "strict_greater_than"


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
