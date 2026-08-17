# -*- coding: utf-8 -*-
"""Memory Consolidation（Phase 7）：Episodic → Semantic 沉淀。

    Episodic（原始事件证据）
        ↓ Consolidation
    Semantic（长期认知）

规则（§12）：
- 必须保留 Episodic 原始证据，绝不删除 Episode
- 新 Semantic 对象 relations.related 记录全部来源 Episode
- 重复证据达到阈值（默认 2）→ active；不足 → candidate
  （对齐「inferred 不得直接升级，除非足够强的重复证据」）
- 已存在同类别 Semantic 时做 REINFORCE 合并（追加 related，不新建重复）
"""

from . import audit
from . import conflict
from . import object_index
from . import schema as S
from . import store
from .schema import now_iso


def load_episodes(episode_ids):
    objs = {}
    for oid in episode_ids:
        obj = store.load_object(oid)
        if not obj:
            raise ValueError("Episode 不存在: %s" % oid)
        if obj.get("type") != "episodic":
            raise ValueError("对象非 episodic，不能作为巩固来源: %s" % oid)
        objs[oid] = obj
    return objs


def consolidate(episode_ids, content, category="preference", scope="global",
                priority="medium", evidence="observed", adapter="memory-engine",
                session_id=None, confirm=False, threshold=2, dry_run=False,
                target_id=None):
    """把一组 Episode 巩固为一个 Semantic 对象。

    target_id：显式指定要 REINFORCE 的既有 Semantic 对象（可选）。
    返回 (action, memory_id, audit_entries)。
    """
    episodes = load_episodes(episode_ids)
    if len(episodes) < 1:
        raise ValueError("至少需要一个 Episode")

    # 既有 Semantic 查找（同类别同范围 + 相似度）
    existing_semantic = [
        o for o in store.load_all_objects()
        if o.get("type") == "semantic"
        and (o.get("classification") or {}).get("category") == category
        and o.get("scope") == scope
    ]

    def best_match():
        best, best_sim = None, 0.0
        for o in existing_semantic:
            sim = conflict.similarity(content, o.get("content"))
            if sim > best_sim:
                best, best_sim = o, sim
        return (best, best_sim) if best_sim >= 0.45 else (None, 0.0)

    match, sim = (None, 0.0)
    if target_id:
        match = store.load_object(target_id)
        if not match:
            raise ValueError("目标 Semantic 不存在: %s" % target_id)
    else:
        match, sim = best_match()

    entries = []
    if match:
        # REINFORCE：追加 related、更新内容为合并表述、刷新 updated_at
        new_obj = dict(match)
        new_obj["content"] = content
        rel = new_obj.setdefault("relations", {})
        related = list(rel.get("related") or [])
        for eid in episode_ids:
            if eid not in related:
                related.append(eid)
        rel["related"] = related
        new_obj["source"]["updated_at"] = now_iso()
        prov = new_obj.setdefault("provenance", {})
        prov["evidence"] = evidence
        prov["source_ref"] = "consolidated:" + ",".join(episode_ids)
        new_obj["status"] = "active"
        if not dry_run:
            store.save_object(new_obj)
            entry = audit.make_entry(
                memory_id=match["id"], operation="REINFORCE",
                adapter=adapter,
                reason="consolidate episodes: %s" % ",".join(episode_ids),
                previous_status=match["status"], new_status="active",
                session_id=session_id,
                extra={"episodes": episode_ids})
            audit.append(entry)
            entries.append(entry)
            object_index.rebuild()
        return "REINFORCE", match["id"], entries

    # 新建 Semantic
    status = "active" if (len(episodes) >= threshold or confirm) else "candidate"
    oid = store.new_id()
    obj = S.new_object(
        oid=oid, type_="semantic", content=content, scope=scope,
        status=status, category=category, evidence=evidence,
        priority=priority, recall_layer="L2" if category == "preference" else None,
        adapter=adapter, session_id=session_id,
        source_kind="observed", related=list(episode_ids),
        source_ref="consolidated:" + ",".join(episode_ids))
    if not dry_run:
        store.save_object(obj)
        entry = audit.make_entry(
            memory_id=oid, operation="CONSOLIDATE", adapter=adapter,
            reason="episodes=%s threshold=%d" % (",".join(episode_ids), threshold),
            previous_status=None, new_status=status, session_id=session_id,
            extra={"episodes": episode_ids})
        audit.append(entry)
        entries.append(entry)
        object_index.rebuild()
    return "CREATE", oid, entries
