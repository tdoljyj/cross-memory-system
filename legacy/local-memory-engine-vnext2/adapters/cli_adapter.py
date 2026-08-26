# -*- coding: utf-8 -*-
"""CLI Adapter：memory.py 使用的标准适配器（经 Memory Engine，不直触 Store）。"""

from .interface import MemoryAdapter
from memory_engine import recall_engine, write_engine, store, schema as S
from memory_engine import object_index


class CLIAdapter(MemoryAdapter):
    name = "cli"

    def read(self, query, tier="T0", **kwargs):
        return recall_engine.recall(query=query, tier=tier, **kwargs)

    def recall(self, query, tier="T0", **kwargs):
        return self.read(query, tier=tier, **kwargs)

    def write(self, candidate, **kwargs):
        if not isinstance(candidate, dict):
            raise TypeError("candidate 必须是 dict")
        if not candidate.get("id"):
            candidate = dict(candidate)
            candidate["id"] = store.new_id()
        return write_engine.perform_write(candidate, **kwargs)

    def update(self, memory_id, content, **kwargs):
        obj = store.load_object(memory_id)
        if not obj:
            raise ValueError("对象不存在: %s" % memory_id)
        candidate = dict(obj)
        candidate["content"] = content
        candidate["source"] = dict(candidate.get("source") or {})
        candidate["source"]["updated_at"] = S.now_iso()
        return write_engine.perform_write(candidate, **kwargs)

    def supersede(self, memory_id, content, **kwargs):
        obj = store.load_object(memory_id)
        if not obj:
            raise ValueError("对象不存在: %s" % memory_id)
        candidate = S.new_object(
            oid=store.new_id(), type_=obj.get("type"), content=content,
            scope=obj.get("scope"), status="active",
            category=(obj.get("classification") or {}).get("category"),
            evidence="explicit",
            priority=(obj.get("classification") or {}).get("priority"),
            recall_layer=(obj.get("classification") or {}).get("recall_layer"),
            adapter=kwargs.get("adapter", self.name),
            session_id=kwargs.get("session_id"),
            tags=obj.get("tags"), entities=obj.get("entities"),
            source_kind="user_explicit",
            project_id=obj.get("project_id"))  # MIV-006：分区标记继承
        return write_engine.perform_write(
            candidate, supersede_target=memory_id, **kwargs)

    def status(self):
        return recall_engine.recall_status_summary()
