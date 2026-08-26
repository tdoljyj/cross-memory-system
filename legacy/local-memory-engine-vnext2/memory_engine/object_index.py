# -*- coding: utf-8 -*-
"""Object Index（Phase 9）：memory/object-index.json —— 派生索引。

事实源 = Memory Object 本身；index 与 object 不一致时 Object 优先（§15）。
索引字段（§15）：id / path / type / scope / status / priority /
category / tags / entities / valid_from / valid_until / supersedes / superseded_by。

doctor 必须能够重建索引（rebuild）。写入引擎每次变更后自动 rebuild。
"""

import json
import os

from . import paths
from . import store

INDEX_SCHEMA_VERSION = 1


def build_index(objects=None):
    """由对象集构造索引 dict（不落盘）。"""
    if objects is None:
        objects = store.load_all_objects(include_invalid=True)
    idx = {
        "schema_version": INDEX_SCHEMA_VERSION,
        "generated_at": "",
        "count": len(objects),
        "objects": {},
    }
    from .schema import now_iso
    idx["generated_at"] = now_iso()
    for obj in objects:
        oid = obj.get("id")
        if not oid:
            continue
        cls = obj.get("classification") or {}
        temporal = obj.get("temporal") or {}
        rel = obj.get("relations") or {}
        idx["objects"][oid] = {
            "path": "memory/objects/%s.json" % oid,
            "type": obj.get("type"),
            "scope": obj.get("scope"),
            "status": obj.get("status"),
            "priority": cls.get("priority"),
            "category": cls.get("category"),
            "tags": obj.get("tags") or [],
            "entities": obj.get("entities") or [],
            "valid_from": temporal.get("valid_from"),
            "valid_until": temporal.get("valid_until"),
            "supersedes": rel.get("supersedes") or [],
            "superseded_by": rel.get("superseded_by") or [],
        }
    return idx


def rebuild(objects=None):
    """重建并落盘 object-index.json。返回写入的索引 dict。"""
    idx = build_index(objects)
    os.makedirs(paths.MEMORY_DIR, exist_ok=True)
    store._atomic_write(paths.OBJECT_INDEX_PATH, store.dumps(idx))
    return idx


def load_index():
    path = paths.OBJECT_INDEX_PATH
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("objects"), dict):
            return data
    except Exception:
        return None
    return None


def is_stale(objects=None, tolerance=2.0):
    """派生索引是否过期：对象文件 mtime 晚于索引 mtime 即 stale。"""
    path = paths.OBJECT_INDEX_PATH
    if not os.path.isfile(path):
        return True
    index_mtime = os.path.getmtime(path)
    latest = index_mtime
    for oid in store.list_object_ids():
        op = store.object_path(oid)
        if os.path.isfile(op):
            latest = max(latest, os.path.getmtime(op))
    return latest > index_mtime + tolerance


def mismatch_report(objects=None, index=None):
    """index↔object 一致性对比（doctor #7/#8/#9）。返回问题列表。

    语义：index 是派生物，object 优先；这里只报告事实差异，
    修复一律 rebuild（不做 index 反向修 object）。
    """
    if objects is None:
        objects = store.load_all_objects(include_invalid=True)
    if index is None:
        index = load_index()
    problems = []
    if not index:
        problems.append("object-index.json 缺失")
        return problems
    real_ids = set(store.list_object_ids())
    index_ids = set(index["objects"].keys())
    for oid in index_ids - real_ids:
        problems.append("index 指向缺失对象文件: %s" % oid)
    for oid in real_ids - index_ids:
        problems.append("orphan 对象文件（不在 index）: %s" % oid)
    by_id = {o.get("id"): o for o in objects}
    for oid in sorted(index_ids & real_ids):
        entry = index["objects"][oid]
        obj = by_id.get(oid)
        if not obj:
            continue
        for field in ("type", "scope", "status", "priority", "category"):
            objval = ((obj.get("classification") or {}).get(field)
                      if field in ("priority", "category") else obj.get(field))
            if entry.get(field) != objval:
                problems.append(
                    "%s: index.%s=%r ≠ object=%r"
                    % (oid, field, entry.get(field), objval))
    return problems
