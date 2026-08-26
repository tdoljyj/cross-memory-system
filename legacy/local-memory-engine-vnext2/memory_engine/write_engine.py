# -*- coding: utf-8 -*-
"""Memory Write Engine（Phase 4）：统一写入决策与执行。

决策输出（§7）：NO_CHANGE / NEW_MEMORY / UPDATE_MEMORY /
SUPERSEDE_MEMORY / DELETE_MEMORY

流程（§7）：
    Conversation → Candidate Detector → Candidate Memory
    → Existing Memory Lookup → Deduplication → Conflict Detection
    → Lifecycle Decision → Write Operation → Canonical Store

核心原则：不是「发现一句重要话 → 写进去」，而是「这句话是否改变了长期模型」。

四种核心场景（§8）：
A. 全新记忆 → NEW_MEMORY
B. 重复记忆 → NO_CHANGE（不得产生 duplicate）
C. 更新（明确改变）→ SUPERSEDE_MEMORY（旧 status=superseded，新 active）
D. 否决 → constraint / negative_preference + 与 X 建立关系

护栏：
- inferred 不能直接升级为长期事实（candidate，除非 confirm/explicit）
- AI inference 绝不覆盖 user_explicit
- 被推翻的旧记忆不删除（superseded），历史保留
- 对象写入前做凭据样值扫描（拒绝令牌入库）
- 引擎不做 git commit/push（Sync Layer 职责，§2 目标架构）
"""

from . import audit
from . import conflict
from . import lifecycle
from . import object_index
from . import paths
from . import schema as S
from . import store
from .schema import now_iso

DECISIONS = (
    "NO_CHANGE", "NEW_MEMORY", "UPDATE_MEMORY",
    "SUPERSEDE_MEMORY", "DELETE_MEMORY",
)

# MIV-006（ADR-MIV-006-001 D3）：这些是查询侧 disposition，绝不进入
# 长期记忆（memory/objects/）。写入一律 fail-closed 拒绝（零副作用）。
EPHEMERAL_SCOPES = ("session_only", "temporary")


class WriteResult(object):
    """一次写入操作的完整结果（供 CLI/Adapter/测试断言）。"""

    def __init__(self, decision, memory_id=None, target_id=None,
                 status=None, reason="", audit_entries=None,
                 superseded_ids=None, created_ids=None):
        self.decision = decision
        self.memory_id = memory_id          # 新对象的 id（NEW/SUPERSEDE）
        self.target_id = target_id          # 被更新/归档/推翻的旧对象 id
        self.status = status
        self.reason = reason
        self.audit_entries = audit_entries or []
        self.superseded_ids = superseded_ids or []
        self.created_ids = created_ids or []

    def to_dict(self):
        return {
            "decision": self.decision,
            "memory_id": self.memory_id,
            "target_id": self.target_id,
            "status": self.status,
            "reason": self.reason,
            "audit_entries": self.audit_entries,
            "superseded_ids": self.superseded_ids,
            "created_ids": self.created_ids,
        }


def _candidate_snapshot(candidate):
    """规范化候选（不落盘）。"""
    return dict(candidate)


def candidate_lookup(candidate, objects):
    """Existing Memory Lookup：按类别+范围+状态初筛，再按相似度/实体匹配。

    MIV-006：project 分区下按 (scope, project_id) 匹配（project_id 缺失
    按 null），杜绝跨项目 UPDATE/SUPERSEDE 串扰。
    """
    c_cat = (candidate.get("classification") or {}).get("category")
    c_scope = candidate.get("scope")
    c_pid = candidate.get("project_id") or None
    out = []
    for obj in objects:
        o_cat = (obj.get("classification") or {}).get("category")
        if obj.get("scope") != c_scope:
            continue
        if c_scope == "project" and \
                (obj.get("project_id") or None) != c_pid:
            continue
        if c_cat and o_cat and c_cat != o_cat:
            continue
        out.append(obj)
    return out


def decide(candidate, objects):
    """只决策、不落盘。返回 (decision, matched_obj_or_None, reason)。

    NO_CHANGE：candidate 未改变长期模型（重复/无新意）
    UPDATE_MEMORY：同对象细化
    SUPERSEDE_MEMORY：同实体值变更/反向（新证据胜）
    NEW_MEMORY：无既有对应
    DELETE_MEMORY：否决场景不物理删除——由显式 archive 入口承担
    """
    cand = _candidate_snapshot(candidate)
    content = (cand.get("content") or "").strip()
    if not content:
        return "NO_CHANGE", None, "空内容不构成记忆"
    cand["content"] = content

    pool = candidate_lookup(cand, objects)
    for obj in pool:
        level, why = conflict.conflict_level(cand, obj)
        if level is None:
            continue
        action, explanation = conflict.decide(cand, obj, level, why)
        if action == "no_change":
            return "NO_CHANGE", obj, explanation
        if action == "update":
            return "UPDATE_MEMORY", obj, explanation
        if action == "supersede":
            return "SUPERSEDE_MEMORY", obj, explanation
        if action == "reject_new":
            return "NO_CHANGE", obj, explanation
    return "NEW_MEMORY", None, "无既有对应记忆"


def perform_write(candidate, objects=None, adapter="memory-engine",
                  session_id=None, explicit_remember=False, confirm=False,
                  force=False, dry_run=False, supersede_target=None):
    """执行写入决策（§4 全流程，含审计与索引重建）。

    参数：
    - candidate         : Memory Object 候选（含 id 或自动分配）
    - explicit_remember : T4「记住」→ 直接 ACTIVE
    - confirm           : 将 candidate 确认升级为 active
    - force             : 跳过 secret 扫描（仅供测试构造，生产禁用）
    - dry_run           : 只返回决策，不落盘
    - supersede_target  : 用户明确要求推翻的旧对象 id（§9 优先级第一：
                          用户当前明确表达 > 一切）——强制 SUPERSEDE_MEMORY

    返回 WriteResult。落盘副作用：对象文件 + audit.log + object-index.json。
    """
    if objects is None:
        objects = store.load_all_objects()
    cand = _candidate_snapshot(candidate)

    # 0) MIV-006：临时/会话 disposition 拒绝持久化（fail-closed，零副作用）
    if cand.get("scope") in EPHEMERAL_SCOPES:
        raise ValueError(
            "EPHEMERAL_SCOPE_NOT_PERSISTED: scope=%r 不产生长期写入"
            "（会话运行期 store 未实现，本阶段 fail-closed）"
            % (cand.get("scope"),))

    # 1) 生命周期默认状态（§6.1/§6.4）+ 候选确认，然后校验
    if explicit_remember:
        cand["status"] = "active"          # T4 明确记忆：无条件直接 ACTIVE
    elif not cand.get("status"):
        cand["status"] = lifecycle.default_status_for(
            (cand.get("provenance") or {}).get("evidence"))
    if confirm and cand["status"] == "candidate":
        cand["status"] = "active"
    ok, errors = S.validate_object(cand)
    if not ok:
        raise ValueError("候选对象校验失败: %s" % "; ".join(errors))

    # 2) 凭据样值扫描（§19/附录C；force 仅测试用）
    if not force and store.find_secret_in_object(cand):
        raise ValueError(
            "对象内容含疑似密钥/令牌样值，拒绝写入（guards.json 模式）")

    if supersede_target:
        matched = store.load_object(supersede_target)
        if not matched:
            raise ValueError("推翻目标不存在: %s" % supersede_target)
        decision = "SUPERSEDE_MEMORY"
        reason = "用户明确要求推翻旧记忆（当前明确表达 > 一切）"
    else:
        decision, matched, reason = decide(cand, objects)
    audit_entries = []

    def log(memory_id, operation, prev_status=None, new_status=None,
            extra=None):
        audit_entries.append(audit.make_entry(
            memory_id=memory_id, operation=operation, adapter=adapter,
            reason=reason, previous_status=prev_status,
            new_status=new_status, session_id=session_id, extra=extra))

    result = WriteResult(decision, reason=reason)

    if decision == "NO_CHANGE":
        # NO_CHANGE → NO_WRITE → NO_SYNC → NO_INVALIDATION（基线原则 8）：
        # 不写对象、不写审计、不重建索引，零副作用返回。
        result.target_id = matched.get("id") if matched else None
        result.status = matched.get("status") if matched else None
        return result

    if decision == "DELETE_MEMORY":
        # 显式删除 = archive（物理删除留给 git 与用户决策，§6.7/附录C.5）
        if not matched:
            raise ValueError("DELETE_MEMORY 需要目标对象")
        new_obj, note = lifecycle.apply_transition(
            matched, "archived", actor=adapter,
            reason="用户要求删除（归档，不物理删除）")
        new_obj["source"]["updated_at"] = now_iso()
        result.target_id = matched["id"]
        result.status = "archived"
        if not dry_run:
            store.save_object(new_obj)
            log(matched["id"], "ARCHIVE", matched.get("status"), "archived")
            for e in audit_entries:
                audit.append(e)
            object_index.rebuild()
        return result

    if decision == "UPDATE_MEMORY":
        target = matched
        new_obj = dict(target)
        new_obj["content"] = cand["content"]
        new_obj["source"]["updated_at"] = now_iso()
        if cand.get("tags"):
            new_obj["tags"] = cand["tags"]
        if cand.get("entities"):
            new_obj["entities"] = cand["entities"]
        new_obj["provenance"] = dict(cand.get("provenance") or
                                     new_obj.get("provenance") or {})
        new_obj["provenance"]["source_ref"] = (
            cand.get("provenance") or {}).get(
                "source_ref", new_obj["provenance"].get("source_ref"))
        ok2, errs2 = S.validate_object(new_obj)
        if not ok2:
            raise ValueError("更新后对象校验失败: %s" % "; ".join(errs2))
        result.target_id = target["id"]
        result.memory_id = target["id"]
        result.status = target["status"]
        if not dry_run:
            store.save_object(new_obj)
            log(target["id"], "UPDATE", target["status"], target["status"])
            for e in audit_entries:
                audit.append(e)
            object_index.rebuild()
        return result

    if decision == "SUPERSEDE_MEMORY":
        old = matched
        new_obj = dict(cand)
        oid = new_obj.get("id") or store.new_id()
        new_obj["id"] = oid
        new_obj["status"] = "active"
        # MIV-006：分区标记继承——supersede 不得丢失旧对象 project_id
        if new_obj.get("scope") == "project" and \
                not new_obj.get("project_id") and old.get("project_id"):
            new_obj["project_id"] = old.get("project_id")
        rel = new_obj.setdefault("relations", {})
        rel.setdefault("supersedes", [])
        if old["id"] not in rel["supersedes"]:
            rel["supersedes"].append(old["id"])
        new_obj["source"]["updated_at"] = now_iso()
        # 时间记忆：旧对象 valid_until = now（§11 CURRENT vs HISTORY）
        old_obj = dict(old)
        old_obj["status"] = "superseded"
        old_obj.setdefault("relations", {}).setdefault("superseded_by", [])
        if oid not in old_obj["relations"]["superseded_by"]:
            old_obj["relations"]["superseded_by"].append(oid)
        old_obj.setdefault("temporal", {})["valid_until"] = now_iso()
        old_obj["source"]["updated_at"] = now_iso()
        ok2, errs2 = S.validate_object(new_obj)
        if not ok2:
            raise ValueError("新对象校验失败: %s" % "; ".join(errs2))
        result.target_id = old["id"]
        result.memory_id = oid
        result.status = "active"
        result.superseded_ids = [old["id"]]
        result.created_ids = [oid]
        if not dry_run:
            store.save_object(old_obj)
            store.save_object(new_obj)
            log(oid, "CREATE", None, "active")
            log(old["id"], "SUPERSEDE", old["status"], "superseded",
                extra={"superseded_by": oid})
            for e in audit_entries:
                audit.append(e)
            object_index.rebuild()
        return result

    # NEW_MEMORY
    new_obj = dict(cand)
    oid = new_obj.get("id") or store.new_id()
    new_obj["id"] = oid
    if not new_obj.get("status"):
        new_obj["status"] = lifecycle.default_status_for(
            (new_obj.get("provenance") or {}).get("evidence"),
            explicit_remember=explicit_remember)
    if confirm and new_obj["status"] == "candidate":
        new_obj["status"] = "active"
    ok2, errs2 = S.validate_object(new_obj)
    if not ok2:
        raise ValueError("新对象校验失败: %s" % "; ".join(errs2))
    result.memory_id = oid
    result.status = new_obj["status"]
    result.created_ids = [oid]
    if not dry_run:
        store.save_object(new_obj)
        log(oid, "CREATE", None, new_obj["status"])
        for e in audit_entries:
            audit.append(e)
        object_index.rebuild()
    return result


def reject_candidate(oid, adapter="memory-engine", reason="", session_id=None):
    """candidate → rejected（§6：CANDIDATE → REJECTED）。"""
    obj = store.load_object(oid)
    if not obj:
        raise ValueError("对象不存在: %s" % oid)
    new_obj, note = lifecycle.apply_transition(
        obj, "rejected", actor=adapter, reason=reason)
    new_obj["source"]["updated_at"] = now_iso()
    store.save_object(new_obj)
    entry = audit.make_entry(
        memory_id=oid, operation="REJECT", adapter=adapter, reason=reason,
        previous_status=obj["status"], new_status="rejected",
        session_id=session_id)
    audit.append(entry)
    object_index.rebuild()
    return entry


def archive_object(oid, adapter="memory-engine", reason="", session_id=None):
    """active/superseded → archived（DELETE_MEMORY 语义=归档不物理删除）。"""
    obj = store.load_object(oid)
    if not obj:
        raise ValueError("对象不存在: %s" % oid)
    new_obj, note = lifecycle.apply_transition(
        obj, "archived", actor=adapter, reason=reason)
    new_obj["source"]["updated_at"] = now_iso()
    store.save_object(new_obj)
    entry = audit.make_entry(
        memory_id=oid, operation="ARCHIVE", adapter=adapter, reason=reason,
        previous_status=obj["status"], new_status="archived",
        session_id=session_id)
    audit.append(entry)
    object_index.rebuild()
    return entry
