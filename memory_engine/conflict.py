# -*- coding: utf-8 -*-
"""Conflict Resolver（Phase 6）：确定性冲突检测与裁决。

冲突类型（§9）：
1. 同一事实不同值      → value_change
2. 同一 preference 反向 → contradiction
3. 项目状态冲突         → value_change（project/state/decision 类别）
4. 决策冲突             → value_change（decision）
5. 时间冲突             → value_change + temporal（旧对象 valid_until=now）
6. 用户明确纠正 AI      → contradiction（用户当前 explicit 必胜）

裁决优先级（§9，绝不允许 AI inference 覆盖 user_explicit）：
    用户当前明确表达 > 用户历史明确表达 > 用户长期稳定偏好 >
    用户实际行为 > AI inference

实现方式（确定性，无 NLP 模型）：
- 文本相似度：CJK 字符 bigram + ASCII token 的 Dice 系数（用于去重/相似判定）
- 反向判定：否定词标记（不再/不要/不用/以后不…）+ 实体/标签重叠
- 裁决：evidence 优先级 + 时间戳（同 evidence 时新者胜）
"""

import re

from .schema import EVIDENCE_PRIORITY, parse_ts as S_parse_ts

# 否定/纠正标记（偏好反转判定用）
NEGATION_MARKERS = [
    "不再", "不要", "不用", "别", "以后不", "不喜欢", "不爱", "避免",
    "禁止", "否决", "放弃", "换成", "改为", "改成", "别用", "别推荐",
    "不要再", "千万不要", "停止",
]

_WORD_RE = re.compile(r"[a-z0-9_]+")


def tokenize(text):
    """CJK 字符 bigram + 拉丁/数字单词。用于确定性相似度。"""
    text = (text or "").strip()
    if not text:
        return set()
    tokens = set()
    words = _WORD_RE.findall(text.lower())
    tokens.update(words)
    # CJK 连续段 → bigram
    cjk_runs = re.findall(r"[\u4e00-\u9fff]+", text)
    for run in cjk_runs:
        if len(run) == 1:
            tokens.add(run)
        else:
            for i in range(len(run) - 1):
                tokens.add(run[i:i + 2])
    return tokens


def similarity(a, b):
    """Dice 系数（0~1）。两文本都无 token 时按相等处理。"""
    ta, tb = tokenize(a), tokenize(b)
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return 2.0 * inter / (len(ta) + len(tb))


def has_negation(text):
    return any(m in text for m in NEGATION_MARKERS)


def same_entity(candidate, existing):
    """实体级同一性：标签/实体交集非空。"""
    ca = set(candidate.get("tags") or []) | set(candidate.get("entities") or [])
    eb = set(existing.get("tags") or []) | set(existing.get("entities") or [])
    return bool(ca & eb)


def temporal_disjoint(a, b):
    """两对象时间范围是否完全不相交（不同时期记忆，互不冲突）。

    任一方无任何时间限定 → 视为可能重叠（False）。
    """
    ta = a.get("temporal") or {}
    tb = b.get("temporal") or {}
    fa, ua = S_parse_ts(ta.get("valid_from")), S_parse_ts(ta.get("valid_until"))
    fb, ub = S_parse_ts(tb.get("valid_from")), S_parse_ts(tb.get("valid_until"))
    if fa is None and ua is None:
        return False
    if fb is None and ub is None:
        return False
    import datetime
    MIN = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
    MAX = datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    a0, a1 = fa or MIN, ua or MAX
    b0, b1 = fb or MIN, ub or MAX
    return a1 < b0 or b1 < a0


def conflict_level(candidate, existing):
    """判定候选与既有对象的关系。

    返回 (level, reason)：
    - "identical"    : 内容等价（去重）
    - "refinement"   : 同事实的补充/细化（UPDATE 候选）
    - "value_change" : 同事实不同值（SUPERSEDE 候选，用户明确改变时）
    - "contradiction": 反向偏好 / 明确纠正（SUPERSEDE 必选，用户当前明确表达时）
    - None           : 无冲突（不同记忆）
    """
    c_cat = (candidate.get("classification") or {}).get("category")
    e_cat = (existing.get("classification") or {}).get("category")
    c_scope = candidate.get("scope")
    e_scope = existing.get("scope")

    sim = similarity(candidate.get("content"), existing.get("content"))
    if sim >= 0.85:
        return "identical", "内容相似度 %.2f" % sim
    # 时间范围完全不相交 = 不同时期的不同记忆（CURRENT vs HISTORY，§11）
    if temporal_disjoint(candidate, existing):
        return None, "时间范围不相交（不同时期记忆）"

    def new_value_entities():
        """新候选引入的、旧对象没有的值实体（如 Maya → Blender）。"""
        old_ents = set(existing.get("entities") or [])
        new_ents = set(candidate.get("entities") or [])
        return new_ents - old_ents

    if sim >= 0.45 and c_cat == e_cat and c_scope == e_scope:
        if not same_entity(candidate, existing):
            return "refinement", "同类别同范围、内容相关（sim=%.2f）" % sim
        if c_cat in ("project", "state", "decision"):
            return "value_change", "同实体项目状态/决策变化（sim=%.2f）" % sim
        if c_cat in ("preference", "negative_preference"):
            if has_negation(candidate.get("content")) != \
                    has_negation(existing.get("content")):
                return "contradiction", "同实体偏好极性相反"
            if new_value_entities():
                return "value_change", "同实体偏好值变更（新值实体 %s）" % \
                    ", ".join(sorted(new_value_entities()))
            return "refinement", "同实体偏好细化（sim=%.2f）" % sim

    # 低相似度但同实体同范围的偏好：极性相反 = 明确纠正；引入新值实体 = 值变更
    if c_cat in ("preference", "negative_preference") and e_cat in (
            "preference", "negative_preference") and c_scope == e_scope \
            and same_entity(candidate, existing):
        if has_negation(candidate.get("content")) != \
                has_negation(existing.get("content")):
            return "contradiction", "同实体偏好极性相反（sim=%.2f）" % sim
        if new_value_entities():
            return "value_change", "同实体偏好值变更（新值实体 %s，sim=%.2f）" % (
                ", ".join(sorted(new_value_entities())), sim)
    return None, ""


def evidence_wins(new_evidence, new_time, old_evidence, old_time):
    """裁决哪一方胜出（§9 优先级梯）。

    返回 True = 新证据胜（可覆盖/推翻旧），False = 旧证据胜。
    绝不允许 inferred 覆盖 explicit / observed。
    """
    np_ = EVIDENCE_PRIORITY.get(new_evidence, 0)
    op_ = EVIDENCE_PRIORITY.get(old_evidence, 0)
    if np_ > op_:
        return True
    if np_ < op_:
        return False
    # 同级别：新者胜（用户当前表达 > 历史表达）
    nt = S_parse_ts(new_time)
    ot = S_parse_ts(old_time)
    if nt and ot:
        return nt >= ot
    return True


def decide(candidate, existing, level, reason):
    """裁决写入动作（供 write_engine 使用）。

    返回 (action, explanation)：
    - "no_change"    : 内容重复（identical）→ NO_CHANGE
    - "update"       : refinement 且新证据不弱于旧 → UPDATE_MEMORY
    - "supersede"    : value_change/contradiction 且新证据胜 → SUPERSEDE_MEMORY
    - "reject_new"   : 新证据弱（inferred 撞 explicit/observed）→ 保留旧、新候选拒绝
    """
    if level == "identical":
        return "no_change", "重复记忆：" + reason
    new_ev = (candidate.get("provenance") or {}).get("evidence")
    old_ev = (existing.get("provenance") or {}).get("evidence")
    new_t = (candidate.get("source") or {}).get("updated_at")
    old_t = (existing.get("source") or {}).get("updated_at")
    if level == "refinement":
        # 细化也是写入：inferred 不得覆盖 explicit/observed 的同事实
        if evidence_wins(new_ev, new_t, old_ev, old_t):
            return "update", "同事实细化（%s 胜 %s）：%s" % (
                new_ev, old_ev, reason)
        return "reject_new", (
            "AI inference 不得覆盖 user_explicit/observed（旧=%s 新=%s）：%s"
            % (old_ev, new_ev, reason))
    if level in ("value_change", "contradiction"):
        if evidence_wins(new_ev, new_t, old_ev, old_t):
            return "supersede", "新旧证据裁决（%s %s 胜 %s %s）：%s" % (
                new_ev, new_t, old_ev, old_t, reason)
        return "reject_new", (
            "AI inference 不得覆盖 user_explicit/observed（旧=%s 新=%s）：%s"
            % (old_ev, new_ev, reason))
    return "no_change", "无冲突"
