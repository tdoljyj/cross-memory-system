# -*- coding: utf-8 -*-
"""Memory Lifecycle（Phase 3）。

状态机（§6）：

    CANDIDATE ──► ACTIVE ──► REINFORCED ──► SUPERSEDED ──► ARCHIVED
        │            │            │              │
        ▼            ▼            ▼              ▼
    REJECTED     EXPIRED      DEPRECATED     ARCHIVED

第一阶段最小实现：candidate / active / superseded / archived / rejected；
expired / deprecated / reinforced 已在 schema 接受，转换规则如下：
- candidate → active：用户确认 / T4 明确记住 / 强化证据足够（consolidation）
- candidate → rejected：候选审查未通过
- active → superseded：被新记忆推翻（新对象 relations.supersedes 指向旧对象）
- active → expired：valid_until 已过（时间记忆自然过期）
- active → deprecated：不再推荐但保留历史
- active → reinforced：重复证据强化（consolidation 次数 +1，语义上仍可召回）
- superseded → archived：历史沉淀
- 终态：archived / rejected 不再转换（历史只读）

规则（§6）：
1. 对话中的新信息默认不是 ACTIVE（candidate）
2. T4「记住」→ 直接 ACTIVE
3. 用户纠正旧记忆 → UPDATE 或 SUPERSEDE
4. 被推翻的旧记忆不删除（status=superseded）
5. 新记忆记录 supersedes
6. retrieval 默认不返回 superseded；history 查询允许返回
"""

TRANSITIONS = {
    "candidate": {"active", "rejected", "superseded", "archived"},
    "active": {"reinforced", "superseded", "expired", "deprecated", "archived"},
    "reinforced": {"active", "superseded", "expired", "deprecated", "archived"},
    "superseded": {"archived"},
    "expired": {"archived"},
    "deprecated": {"archived"},
    "archived": set(),
    "rejected": set(),
}

TERMINAL_STATUSES = ("archived", "rejected")


def valid_transition(from_status, to_status):
    if from_status == to_status:
        return True
    return to_status in TRANSITIONS.get(from_status, set())


def default_status_for(evidence, explicit_remember=False):
    """新记忆初始状态（§6.1/§6.4 + Write Engine 规则）：
    - T4 明确要求记住（explicit_remember）→ active
    - 用户明确表达（evidence=explicit）→ active
    - observed / inferred → candidate（inferred 不得直接升级为长期事实）
    """
    return S.default_status_for(evidence, explicit_remember)


def apply_transition(obj, to_status, actor="memory-engine", reason=""):
    """返回 (新对象, 变更说明)。不直接写盘（写盘由 write_engine/audit 负责）。"""
    from_status = obj.get("status")
    if not valid_transition(from_status, to_status):
        raise ValueError(
            "非法生命周期转换: %s → %s" % (from_status, to_status))
    new = dict(obj)
    new["status"] = to_status
    return new, "%s → %s%s" % (
        from_status, to_status, ("（" + reason + "）" if reason else ""))
