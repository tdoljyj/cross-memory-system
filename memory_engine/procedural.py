# -*- coding: utf-8 -*-
"""Procedural Memory（Phase 8）：工作流程 / 已验证方法 / 工具链。

语义（§13）：不是「用户喜欢什么」，而是「如何帮助这个用户完成事情」。
可记录：工作流程、已验证的方法、常用工具链、用户要求的执行方式、项目操作模式。
未来 AI 遇到类似任务时直接调用。

实现：type=procedural + category ∈ {workflow, toolchain, method} +
tags/entities 承载任务锚点（如 UE/Maya/GroundMate）。召回走 Recall Engine
的 tag/entity 匹配。
"""

from . import audit
from . import object_index
from . import schema as S
from . import store


def create_procedural(content, category="workflow", scope="global",
                      priority="medium", evidence="explicit", tags=None,
                      entities=None, adapter="memory-engine", session_id=None,
                      status=None, source_ref=None):
    """创建一条 Procedural 记忆（evidence=explicit → active）。"""
    if category not in ("workflow", "toolchain", "method"):
        raise ValueError(
            "procedural 类别须为 workflow/toolchain/method: %r" % (category,))
    status = status or S.default_status_for(evidence)
    oid = store.new_id()
    obj = S.new_object(
        oid=oid, type_="procedural", content=content, scope=scope,
        status=status, category=category, evidence=evidence,
        priority=priority, adapter=adapter, session_id=session_id,
        tags=tags, entities=entities, source_ref=source_ref)
    store.save_object(obj)
    entry = audit.make_entry(
        memory_id=oid, operation="CREATE", adapter=adapter,
        reason="procedural %s" % category,
        previous_status=None, new_status=status, session_id=session_id)
    audit.append(entry)
    object_index.rebuild()
    return oid


def find_procedural(query="", scope=None, limit=10):
    """按任务锚点查找 Procedural 记忆（委托 Recall Engine 的类别过滤）。"""
    from . import recall_engine
    result = recall_engine.recall(
        query=query, tier="T2", scope=scope,
        categories=["workflow", "toolchain", "method"], limit=limit)
    return result.objects
