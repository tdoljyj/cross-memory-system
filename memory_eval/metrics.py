# -*- coding: utf-8 -*-
"""Memory Eval 指标合同 v2.0（MIV-005A）。

v1 指标（§MIV-001）全部保留并标记 legacy_v1，语义与公式不变、
不回写历史（memory_eval_baseline/** 冻结）。

v2 新增（metric_contract_version = 2.0）：
- precision_at5_v2     ：全部实际返回 Top-5 条目中 relevant 的比例（聚合口径）；
                         分母 = 所有非空召回 case 的 Top-5 条目总数，分子 =
                         其中属于 expected_relevant_ids 的条目数。
- hit_rate_at5         ：正例（expected_relevant_ids 非空）中至少一个
                         golden ID 进入 Top-5 的比例。
- false_recall_rate_v2 ：错误返回对象数 / 全部返回对象数；每个对象只计
                         一次（wrong = (returned - expected) ∪
                         (returned ∩ forbidden)，修正 v1 对 extra 与
                         forbidden 命中同一对象时的重复计数）。
- critical_memory_recall_v2：与 v1 critical_memory_recall 同公式（golden
                         命中数 / golden 总数），在 v2 上下文输出并附带切片。

v2 数值一律四舍五入（round-half-up）到 4 位小数；v1 字段的舍入方式保持
原样（round()），不得静默改变 v1 语义。

「Precision@5 ≥90%」自本版本起统一指 precision_at5_v2（见
ADR-MIV-005A-001）。
"""

import math

METRIC_CONTRACT_VERSION = 2.0

# v1 字段清单（顶层继续输出，同时在 legacy_v1 命名空间下显式标记）
LEGACY_V1_FIELDS = [
    "precision_at5",
    "critical_memory_recall",
    "false_recall_rate",
    "stale_recall_rate",
    "current_scope_leakage_count",
    "project_only_capability_gap_count",
    "superseded_leakage_count",
    "no_memory_correctness",
    "no_memory_violations",
    "cross_agent_consistency",
    "estimated_prompt_tokens_p50",
    "estimated_prompt_tokens_p95",
    "recall_latency_ms_p50",
    "recall_latency_ms_p95",
    "missed_items",
    "forbidden_hits",
    "per_category",
]


def _frac_v2(num, den):
    """v2 比率：round-half-up 到 4 位小数（对齐 MIV-005A 验收口径）。"""
    if not den:
        return None
    return math.floor(num / den * 10000.0 + 0.5) / 10000.0


def _wrong_objects(v):
    """错误返回对象集合：每个对象只计一次。

    wrong = (returned - expected) ∪ (returned ∩ forbidden)
    禁止 v1 的 extra + forbidden 重复计数。
    """
    returned = set(v["returned_ids"])
    expected = set(v["expected_relevant_ids"])
    forbidden = set(v["forbidden_ids"])
    return (returned - expected) | (returned & forbidden)


def compute_v2_slice(verdicts):
    """对一组 verdicts 计算 v2 指标切片（纯聚合，无副作用）。"""
    with_return = [v for v in verdicts if v["returned_ids"]]
    rel_top5 = sum(
        len(set(v["returned_ids"][:5]) & set(v["expected_relevant_ids"]))
        for v in with_return)
    top5_total = sum(len(v["returned_ids"][:5]) for v in with_return)
    precision_at5_v2 = _frac_v2(rel_top5, top5_total)

    positive = [v for v in verdicts if v["expected_relevant_ids"]]
    hit_cases = sum(
        1 for v in positive
        if set(v["expected_relevant_ids"]) & set(v["returned_ids"][:5]))
    hit_rate_at5 = _frac_v2(hit_cases, len(positive))

    wrong_total = sum(len(_wrong_objects(v)) for v in with_return)
    returned_total = sum(len(v["returned_ids"]) for v in with_return)
    false_recall_rate_v2 = _frac_v2(wrong_total, returned_total)

    crit_hit = sum(len(set(v["expected_relevant_ids"]) &
                       set(v["returned_ids"]))
                   for v in verdicts if v["expected_relevant_ids"])
    crit_total = sum(len(set(v["expected_relevant_ids"]))
                     for v in verdicts if v["expected_relevant_ids"])
    critical_memory_recall_v2 = _frac_v2(crit_hit, crit_total)

    return {
        "cases": len(verdicts),
        "positive_cases": len(positive),
        "golden_ids": crit_total,
        "returned_objects": returned_total,
        "wrong_objects": wrong_total,
        "precision_at5_v2": precision_at5_v2,
        "hit_rate_at5": hit_rate_at5,
        "false_recall_rate_v2": false_recall_rate_v2,
        "critical_memory_recall_v2": critical_memory_recall_v2,
    }


def compute_v2(verdicts):
    """全量 + 非 paraphrase / paraphrase 切片。"""
    non_paraphrase = [v for v in verdicts if v["category"] != "paraphrase"]
    paraphrase = [v for v in verdicts if v["category"] == "paraphrase"]
    out = compute_v2_slice(verdicts)
    out["slices"] = {
        "non_paraphrase": compute_v2_slice(non_paraphrase),
        "paraphrase": compute_v2_slice(paraphrase),
    }
    return out
