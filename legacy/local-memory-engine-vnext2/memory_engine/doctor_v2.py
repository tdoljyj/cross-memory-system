# -*- coding: utf-8 -*-
"""Memory Engine Doctor（Phase 10）：对象 / 生命周期 / 索引体检。

17 项新检查（执行计划 §20）：
1  object schema validation        2  duplicate memory（active 重复内容）
3  broken relation                 4  dangling supersedes
5  invalid status                  6  invalid temporal range
7  object-index mismatch           8  missing object file
9  orphan object file              10 Markdown/Object divergence
11 forbidden secrets               12 invalid scope
13 invalid memory type             14 invalid evidence
15 superseded 被 recall 返回       16 current memory conflict
17 stale derived index（WARN，--fix 重建）

判定：PASS / WARN / FAIL。任一 FAIL → exit 1。
`--fix` 只重建派生索引（Object 是事实源，绝不自动改对象）。
与 sync-memory.py doctor 的分工：同步层体检（git/护栏/refs/远端）不动；
本引擎体检只覆盖对象层，二者互补、不互相替代。
"""

import os

from . import audit as audit_mod
from . import object_index
from . import paths
from . import recall_engine
from . import schema as S
from . import store
from . import temporal as T


class Report(object):
    def __init__(self):
        self.lines = []       # (kind, name, detail)
        self.failures = []
        self.warnings = []

    def add(self, name, ok, detail="", warn=False):
        kind = "PASS" if ok else ("WARN" if warn else "FAIL")
        self.lines.append((kind, name, detail))
        if not ok and not warn:
            self.failures.append(name)
        if not ok and warn:
            self.warnings.append(name)

    @property
    def ok(self):
        return not self.failures


def _load_all_with_paths():
    """加载全部对象（含无效者），返回 [(path, obj)]。"""
    items = []
    for oid in store.list_object_ids():
        p = store.object_path(oid)
        obj = store.load_object(oid)
        items.append((p, obj))
    return items


def run_doctor(fix=False):
    store.ensure_dirs()
    rep = Report()
    items = _load_all_with_paths()
    objs = [o for _, o in items if o is not None]
    by_id = {o["id"]: o for o in objs}
    valid_objs = []

    # 1/5/12/13/14 schema 族
    schema_bad = []
    for p, obj in items:
        if obj is None:
            schema_bad.append("%s（JSON 无法解析）" % os.path.basename(p))
            continue
        ok, errors = S.validate_object(obj)
        if ok:
            valid_objs.append(obj)
        else:
            schema_bad.append("%s（%s）" % (os.path.basename(p), "; ".join(errors)))
    rep.add("object schema validation", not schema_bad, "; ".join(schema_bad))

    invalid = [o for o in objs if not S.validate_object(o)[0]]
    rep.add("invalid status", not any(
        o.get("status") not in S.STATUSES for o in objs),
        "; ".join(sorted({o.get("id", "?") for o in objs
                          if o.get("status") not in S.STATUSES})))
    rep.add("invalid scope", not any(
        o.get("scope") not in S.SCOPES for o in objs),
        "; ".join(sorted({o.get("id", "?") for o in objs
                          if o.get("scope") not in S.SCOPES})))
    rep.add("invalid memory type", not any(
        o.get("type") not in S.FUNCTION_TYPES for o in objs),
        "; ".join(sorted({o.get("id", "?") for o in objs
                          if o.get("type") not in S.FUNCTION_TYPES})))
    rep.add("invalid evidence", not any(
        (o.get("provenance") or {}).get("evidence") not in S.EVIDENCES
        for o in objs),
        "; ".join(sorted({o.get("id", "?") for o in objs
                          if (o.get("provenance") or {}).get("evidence")
                          not in S.EVIDENCES})))

    # 6 invalid temporal range
    bad_temporal = []
    for o in objs:
        t = o.get("temporal") or {}
        vf, vu = S.parse_ts(t.get("valid_from")), S.parse_ts(t.get("valid_until"))
        if vf and vu and vu < vf:
            bad_temporal.append(o["id"])
    rep.add("invalid temporal range", not bad_temporal,
            "; ".join(bad_temporal))

    # 2 duplicate memory（active 重复内容）
    from . import conflict
    dupes = []
    actives = [o for o in valid_objs
               if o.get("status") in S.RECALLABLE_STATUSES]
    for i in range(len(actives)):
        for j in range(i + 1, len(actives)):
            a, b = actives[i], actives[j]
            if (a.get("scope") != b.get("scope")):
                continue
            ca = (a.get("classification") or {}).get("category")
            cb = (b.get("classification") or {}).get("category")
            if ca != cb:
                continue
            if conflict.similarity(a.get("content"), b.get("content")) >= 0.85:
                dupes.append("%s≈%s" % (a["id"], b["id"]))
    rep.add("duplicate memory (active)", not dupes, "; ".join(dupes))

    # 3 broken relation / 4 dangling supersedes
    broken, dangling = [], []
    for o in objs:
        rel = o.get("relations") or {}
        for target in (rel.get("supersedes") or []) + \
                (rel.get("contradicts") or []) + (rel.get("related") or []) + \
                (rel.get("superseded_by") or []):
            if target not in by_id:
                broken.append("%s→%s" % (o["id"], target))
        for target in (rel.get("supersedes") or []):
            t = by_id.get(target)
            if not t:
                continue
            if t.get("status") not in ("superseded", "archived"):
                dangling.append("%s→%s(status=%s)"
                                % (o["id"], target, t.get("status")))
            if o["id"] not in (t.get("relations") or {}).get(
                    "superseded_by") or []:
                dangling.append("%s→%s 缺少反向 superseded_by"
                                % (o["id"], target))
    rep.add("broken relation", not broken, "; ".join(broken))
    rep.add("dangling supersedes", not dangling, "; ".join(dangling))

    # 7/8/9/17 index 族
    idx = object_index.load_index()
    # 空对象库 + 索引缺失 = 可自愈（生成空派生索引，对齐 sync doctor 的
    # tracking ref AUTO-HEALED 精神；派生索引不是事实源，生成零风险）
    if idx is None and not items:
        object_index.rebuild([])
        idx = object_index.load_index()
        rep.lines.append(("FIX", "object-index init (AUTO-HEALED)",
                          "空对象库自动生成空索引"))
    real_ids = set(store.list_object_ids())
    index_ids = set((idx or {}).get("objects") or {})
    missing_files = sorted(index_ids - real_ids)
    orphans = sorted(real_ids - index_ids)
    mismatch = object_index.mismatch_report(objs, idx)
    stale = object_index.is_stale(objs)
    if fix and (mismatch or stale or idx is None):
        object_index.rebuild(objs)
        idx = object_index.load_index()
        index_ids = set((idx or {}).get("objects") or {})
        missing_files = sorted(index_ids - real_ids)
        orphans = sorted(real_ids - index_ids)
        mismatch = object_index.mismatch_report(objs, idx)
        stale = object_index.is_stale(objs)
        rep.lines.append(("FIX", "object-index rebuild", "已重建派生索引"))
    rep.add("object-index mismatch", not mismatch, "; ".join(mismatch))
    rep.add("missing object file", not missing_files,
            "; ".join(missing_files))
    rep.add("orphan object file", not orphans, "; ".join(orphans))
    rep.add("stale derived index", not stale,
            "对象变更后索引未重建（--fix 重建）", warn=stale)

    # 10 Markdown/Object divergence（source_ref 指向的段是否仍存在）
    diverged = []
    memdir = paths.MEMORY_DIR
    for o in objs:
        ref = (o.get("provenance") or {}).get("source_ref") or ""
        if "##" not in ref:
            continue
        fname, _, sec = ref.partition("##")
        fname = fname.strip()
        sec = sec.strip()
        if not fname:
            continue
        fp = os.path.join(memdir, os.path.basename(fname))
        if not os.path.isfile(fp):
            diverged.append("%s（源文件缺失 %s）" % (o["id"], fname))
            continue
        try:
            with open(fp, "r", encoding="utf-8") as fh:
                text = fh.read()
        except Exception:
            diverged.append("%s（源文件不可读 %s）" % (o["id"], fname))
            continue
        if sec and ("## " + sec) not in text:
            diverged.append("%s（源段缺失 %s##%s）" % (o["id"], fname, sec))
    rep.add("Markdown/Object divergence", not diverged,
            "; ".join(diverged), warn=bool(diverged))

    # 11 forbidden secrets
    secrets = store.scan_objects_for_secrets()
    rep.add("forbidden secrets", not secrets, "; ".join(secrets))

    # 15 superseded 被 recall 返回
    leaked = []
    for tier in ("T1", "T2", "T3"):
        res = recall_engine.recall("", tier=tier, include_history=False,
                                   limit=100000)
        for o in res.objects:
            if o.get("status") == "superseded":
                leaked.append("%s(tier=%s)" % (o["id"], tier))
    rep.add("superseded not returned by recall", not leaked, "; ".join(leaked))

    # 16 current memory conflict（active 对之间存在 contradicts 关系）
    conflicts_now = []
    for o in objs:
        if o.get("status") not in S.RECALLABLE_STATUSES:
            continue
        for target in (o.get("relations") or {}).get("contradicts") or []:
            t = by_id.get(target)
            if t and t.get("status") in S.RECALLABLE_STATUSES:
                conflicts_now.append("%s↔%s" % (o["id"], target))
    rep.add("current memory conflict", not conflicts_now,
            "; ".join(conflicts_now))

    # 补充信息
    stats = recall_engine.recall_status_summary()
    rep.lines.append(("INFO", "objects",
                      "total=%d by_status=%s" % (
                          stats["total"], stats["by_status"])))
    audit_count = len(audit_mod.read_all())
    rep.lines.append(("INFO", "audit entries", "%d" % audit_count))
    expiring = [o["id"] for o in objs if T.expired_but_active(o)]
    if expiring:
        rep.add("expired-but-active objects", False,
                "以下对象已过 valid_until 但仍 active（建议转 expired）: %s"
                % "; ".join(expiring), warn=True)

    return rep
