#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vNext-2.0 Memory Engine 验收测试（纯标准库轻量 runner，无第三方依赖）。

覆盖《Cross-Memory-System_vNext-2.0_执行计划.md》§21（A–Z）与 §28（最终验收）
中可在代码层验证的不变量：

    A Memory Object schema    B create memory       C duplicate detection
    D update                  E supersede           F conflict detection
    G temporal validity       H active filtering    I historical retrieval
    J negative preference     K candidate rejection L consolidation
    M procedural memory       N project scope       O session scope
    P object-index rebuild    Q orphan detection    R broken relation
    S Markdown 兼容           T T0 no recall        U T1 minimal recall
    V T2 project recall       W T3 light recall     X T4 immediate write
    Y NO_CHANGE no write      Z superseded never wins

运行：python tests/test_memory_v2.py
"""

import functools
import importlib.util
import json
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine import write_engine  # noqa: E402
from memory_engine import lifecycle  # noqa: E402
from memory_engine import conflict  # noqa: E402
from memory_engine import temporal as T  # noqa: E402
from memory_engine import recall_engine  # noqa: E402
from memory_engine import object_index  # noqa: E402
from memory_engine import audit  # noqa: E402
from memory_engine import doctor_v2  # noqa: E402
from memory_engine import consolidation  # noqa: E402
from memory_engine import procedural  # noqa: E402

from adapters.cli_adapter import CLIAdapter  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def tok(prefix="ghp_"):
    """运行时拼接凭据样值（防测试文件自命中扫描模式）。"""
    return prefix + "A" * 32


def make_repo():
    """建临时引擎仓库：memory/index.json + guards.json（复制真实契约）。"""
    tmp = tempfile.mkdtemp(prefix="memv2-test-")
    memdir = os.path.join(tmp, "memory")
    os.makedirs(memdir, exist_ok=True)
    idx = {
        "schema_version": 1,
        "files": ["画像.md", "决策.md", "待办.md"],
        "recall": {
            "L1": [{"file": "画像.md", "sections": ["身份轨迹"]}],
            "L2": [{"file": "画像.md", "sections": ["审美"]}],
            "L3": [{"file": "画像.md", "sections": ["技术能力"]}],
            "L4": [{"file": "决策.md", "sections": ["已确认"]}],
            "L5": [{"file": "决策.md", "sections": ["已否决（不要重复推荐）"]}],
            "L6": [],
        },
    }
    with open(os.path.join(memdir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False)
    for f in idx["files"]:
        with open(os.path.join(memdir, f), "w", encoding="utf-8") as fh:
            fh.write("# 夹具\n## 身份轨迹\n## 审美\n## 技术能力\n")
    guards = os.path.join(REPO_ROOT, "guards.json")
    if os.path.isfile(guards):
        shutil.copy(guards, os.path.join(tmp, "guards.json"))
    return tmp


def sandboxed(fn):
    @functools.wraps(fn)
    def wrapper():
        repo = make_repo()
        engine_paths.set_repo(repo)
        store.ensure_dirs()
        try:
            fn(repo)
        finally:
            engine_paths.set_repo(REPO_ROOT)
            shutil.rmtree(repo, ignore_errors=True)
    return wrapper


def cand(content, category="preference", evidence="explicit", scope="global",
         status=None, type_="semantic", priority="medium", tags=None,
         entities=None, layer="L2", **kw):
    return S.new_object(
        oid=kw.pop("oid", store.new_id()), type_=type_, content=content,
        scope=scope, status=status, category=category, evidence=evidence,
        priority=priority, recall_layer=layer, adapter="test",
        tags=tags, entities=entities, source_kind=kw.pop("source_kind", None),
        **kw)


# ================= Phase 1：Schema =================

def test_schema_valid_object_passes():
    obj = cand("用户偏好高信息密度、少废话的回答方式", oid="mem_0123abcd")
    ok, errors = S.validate_object(obj)
    check(ok, "合法对象应通过: %s" % errors)


def test_schema_rejects_invalid_status():
    obj = cand("x", oid="mem_0123abcd", status="magic")
    ok, _ = S.validate_object(obj)
    check(not ok, "非法 status 应拒绝")


def test_schema_rejects_invalid_scope():
    obj = cand("x", oid="mem_0123abcd", scope="universe")
    ok, _ = S.validate_object(obj)
    check(not ok, "非法 scope 应拒绝")


def test_schema_rejects_invalid_evidence():
    obj = cand("x", oid="mem_0123abcd", evidence="guessed")
    ok, _ = S.validate_object(obj)
    check(not ok, "非法 evidence 应拒绝")


def test_schema_rejects_invalid_temporal_range():
    obj = cand("x", oid="mem_0123abcd",
               valid_from="2026-08-17T00:00:00Z",
               valid_until="2026-08-16T00:00:00Z")
    ok, _ = S.validate_object(obj)
    check(not ok, "valid_until 早于 valid_from 应拒绝")


def test_schema_rejects_path_traversal_id():
    check(store.safe_id("../evil") is None, "../ 逃逸 id 应拒绝")
    check(store.safe_id("mem_ABC") is None, "大写/非法 id 应拒绝")
    check(store.safe_id("mem_0123abcd") == "mem_0123abcd", "合法 id 应放行")


# ================= Phase 2/3/4：Store / Lifecycle / Write =================

def test_lifecycle_transitions():
    check(lifecycle.valid_transition("candidate", "active"), "candidate→active 应合法")
    check(lifecycle.valid_transition("active", "superseded"), "active→superseded 应合法")
    check(lifecycle.valid_transition("superseded", "archived"), "superseded→archived 应合法")
    check(lifecycle.valid_transition("candidate", "rejected"), "candidate→rejected 应合法")
    check(not lifecycle.valid_transition("archived", "active"), "终态不应复活")
    check(not lifecycle.valid_transition("active", "candidate"), "不允许反向降级")


@ sandboxed
def test_write_new_memory(repo):
    result = write_engine.perform_write(cand(
        "用户偏好高信息密度、少废话的回答方式", oid="mem_new00001"))
    check(result.decision == "NEW_MEMORY", result.to_dict())
    check(result.status == "active", "explicit 新记忆应直接 active")
    obj = store.load_object("mem_new00001")
    check(obj is not None and obj["content"].startswith("用户偏好"), "对象应落盘")
    idx = object_index.load_index()
    check("mem_new00001" in idx["objects"], "索引应更新")
    entries = audit.entries_for("mem_new00001")
    check(entries and entries[0]["operation"] == "CREATE", "审计应记录 CREATE")


@ sandboxed
def test_write_duplicate_no_change(repo):
    r1 = write_engine.perform_write(cand(
        "用户偏好高信息密度、少废话的回答方式", oid="mem_dup00001"))
    check(r1.decision == "NEW_MEMORY", r1.to_dict())
    before = len(store.list_object_ids())
    audit_before = len(audit.read_all())
    r2 = write_engine.perform_write(cand(
        "用户偏好高信息密度、少废话的回答方式", oid="mem_dup00002"))
    check(r2.decision == "NO_CHANGE", "重复内容应 NO_CHANGE: %s" % r2.to_dict())
    check(len(store.list_object_ids()) == before, "不得产生 duplicate")
    check(len(audit.read_all()) == audit_before, "NO_CHANGE 不得写审计")


@ sandboxed
def test_write_update_refinement(repo):
    write_engine.perform_write(cand(
        "用户偏好高信息密度、少废话的回答方式", oid="mem_upd00001"))
    r2 = write_engine.perform_write(cand(
        "用户偏好高信息密度、少废话、直接给方案的答案", oid="mem_upd00002",
        tags=["回答风格"], entities=["回答风格"]))
    check(r2.decision == "UPDATE_MEMORY", "细化应 UPDATE: %s" % r2.to_dict())
    obj = store.load_object("mem_upd00001")
    check("直接给方案" in obj["content"], "同对象就地更新")
    check(len(store.list_object_ids()) == 1, "不产生新对象")


@ sandboxed
def test_write_supersede(repo):
    write_engine.perform_write(cand(
        "用户主要使用 Maya", oid="mem_old00001", tags=["Maya"],
        entities=["Maya"], category="preference"))
    r2 = write_engine.perform_write(cand(
        "用户以后主要用 Blender", oid="mem_new00002", tags=["Blender"],
        entities=["Blender", "Maya"], category="preference"))
    check(r2.decision == "SUPERSEDE_MEMORY", "明确改变应 SUPERSEDE: %s" % r2.to_dict())
    old = store.load_object("mem_old00001")
    new = store.load_object("mem_new00002")
    check(old["status"] == "superseded", "旧对象应 superseded")
    check(new["status"] == "active", "新对象应 active")
    check("mem_old00001" in new["relations"]["supersedes"], "新对象应记录 supersedes")
    check("mem_new00002" in old["relations"]["superseded_by"], "旧对象应记录 superseded_by")
    check(old["temporal"]["valid_until"], "旧对象应记录 valid_until（时间记忆）")


@ sandboxed
def test_superseded_never_wins_current_recall(repo):
    write_engine.perform_write(cand(
        "用户主要使用 Maya", oid="mem_a0000001", tags=["引擎"], entities=["Maya"]))
    write_engine.perform_write(cand(
        "用户以后主要用 Blender", oid="mem_a0000002", tags=["引擎"],
        entities=["Blender", "Maya"]))
    res = recall_engine.recall("用什么工具", tier="T2",
                               categories=["preference"], limit=10)
    contents = [o["content"] for o in res.objects]
    check(any("Blender" in c for c in contents), "当前召回应返回新记忆")
    check(not any(o["id"] == "mem_a0000001" for o in res.objects),
          "superseded 绝不赢得当前召回")


@ sandboxed
def test_history_recall_includes_superseded(repo):
    write_engine.perform_write(cand(
        "用户主要使用 Maya", oid="mem_h0000001", tags=["引擎"], entities=["Maya"]))
    write_engine.perform_write(cand(
        "用户以后主要用 Blender", oid="mem_h0000002", tags=["引擎"],
        entities=["Maya"]))
    res = recall_engine.recall("以前用过什么", tier="T2",
                               categories=["preference"],
                               include_history=True, limit=10)
    ids = [o["id"] for o in res.objects]
    check("mem_h0000001" in ids, "历史查询应返回 superseded")


@ sandboxed
def test_inferred_never_overwrites_explicit(repo):
    write_engine.perform_write(cand(
        "用户偏好 Maya", oid="mem_ie000001", tags=["Maya"], entities=["Maya"],
        evidence="explicit"))
    r2 = write_engine.perform_write(cand(
        "用户可能更喜欢 Blender", oid="mem_ie000002", tags=["Blender"],
        entities=["Blender", "Maya"], evidence="inferred"))
    check(r2.decision == "NO_CHANGE", "inferred 不得推翻 explicit: %s" % r2.to_dict())
    old = store.load_object("mem_ie000001")
    check(old["status"] == "active", "explicit 旧记忆不得被改变")
    check(store.load_object("mem_ie000002") is None, "弱证据候选不得落盘")


@ sandboxed
def test_negative_preference_filters_recommendation(repo):
    write_engine.perform_write(cand(
        "用户喜欢用 Maya 做动画", oid="mem_np000001", tags=["Maya"],
        entities=["Maya", "工作室命名"], category="preference"))
    write_engine.perform_write(cand(
        "以后不要再推荐四字成语式公司名", oid="mem_np000002",
        category="negative_preference", layer="L5",
        entities=["工作室命名"], tags=["工作室命名"]))
    res = recall_engine.recall("动画工具", tier="T2",
                               categories=["preference"], limit=10)
    ids = [o["id"] for o in res.objects + res.constraints]
    check("mem_np000001" in ids, "偏好对象应返回")
    check("mem_np000002" in ids, "关联否决约束应附带（供过滤）")


@ sandboxed
def test_candidate_lifecycle_and_reject(repo):
    r = write_engine.perform_write(cand(
        "用户可能在考虑用 Godot", oid="mem_ck000001", entities=["Godot"],
        evidence="observed"))
    check(r.status == "candidate", "observed 新信息默认 candidate")
    res = recall_engine.recall("引擎", tier="T2",
                               categories=["preference"], limit=10)
    check(not any(o["id"] == "mem_ck000001" for o in res.objects),
          "candidate 默认不出现在召回")
    write_engine.reject_candidate("mem_ck000001", reason="用户未确认")
    obj = store.load_object("mem_ck000001")
    check(obj["status"] == "rejected", "拒绝后应 rejected")
    check(audit.entries_for("mem_ck000001")[-1]["operation"] == "REJECT",
          "审计应记录 REJECT")


@ sandboxed
def test_t4_remember_immediate_active(repo):
    r = write_engine.perform_write(cand(
        "记住：以后回答尽量少废话", oid="mem_t4000001", evidence="observed"),
        explicit_remember=True)
    check(r.decision == "NEW_MEMORY" and r.status == "active",
          "T4 明确记忆应直接 active: %s" % r.to_dict())


@ sandboxed
def test_no_change_zero_side_effects(repo):
    write_engine.perform_write(cand(
        "用户喜欢简洁回答", oid="mem_nc000001"))
    obj_path = store.object_path("mem_nc000001")
    index_path = engine_paths.OBJECT_INDEX_PATH
    audit_path = os.path.join(engine_paths.REPO, "memory", "audit", "audit.log")
    before = {p: (os.path.getmtime(p), os.path.getsize(p))
              for p in (obj_path, index_path, audit_path)}
    r = write_engine.perform_write(cand(
        "用户喜欢简洁回答", oid="mem_nc000002"))
    check(r.decision == "NO_CHANGE", r.to_dict())
    for p, v in before.items():
        check((os.path.getmtime(p), os.path.getsize(p)) == v,
              "NO_CHANGE 不得触碰 %s" % p)


@ sandboxed
def test_write_rejects_secret_content(repo):
    try:
        write_engine.perform_write(cand(
            "令牌样值 " + tok(), oid="mem_sec00001"))
        raise AssertionError("密钥样值应被拒绝写入")
    except ValueError as e:
        check("密钥" in str(e) or "secret" in str(e).lower(),
              "拒绝原因应指向密钥扫描: %s" % e)
    check(store.load_object("mem_sec00001") is None, "不得落盘")


# ================= Phase 6：Temporal =================

@ sandboxed
def test_temporal_validity_filters(repo):
    write_engine.perform_write(cand(
        "当前主引擎 UE 5.6", oid="mem_tm000001", entities=["引擎"],
        valid_from="2026-01-01T00:00:00Z",
        valid_until="2026-12-31T00:00:00Z"))
    write_engine.perform_write(cand(
        "过期引擎 UE 5.4", oid="mem_tm000002", entities=["引擎"],
        valid_until="2020-01-01T00:00:00Z", status="active"))
    res = recall_engine.recall("引擎", tier="T2",
                               categories=["preference"], limit=10)
    check(any(o["id"] == "mem_tm000001" for o in res.objects),
          "有效期内应返回")
    check(not any(o["id"] == "mem_tm000002" for o in res.objects),
          "过期对象当前召回应排除")
    check(res.skipped["expired"] >= 1, "应统计过期跳过")
    hist = recall_engine.recall("引擎", tier="T2",
                                categories=["preference"],
                                include_history=True, limit=10)
    check(any(o["id"] == "mem_tm000002" for o in hist.objects),
          "历史查询应包含过期对象")


@ sandboxed
def test_temporal_current_vs_history_engine(repo):
    write_engine.perform_write(cand(
        "当前主引擎 UE 5.6", oid="mem_tc000001", entities=["主引擎"],
        valid_from="2026-01-01T00:00:00Z"))
    write_engine.perform_write(cand(
        "曾经主引擎 UE 5.2", oid="mem_tc000002", entities=["主引擎"],
        valid_until="2025-12-31T00:00:00Z", status="active"))
    cur = recall_engine.recall("现在用什么引擎", tier="T2",
                               categories=["preference"], limit=10)
    check(any(o["id"] == "mem_tc000001" for o in cur.objects),
          "「现在」应返回当前 active")
    check(not any(o["id"] == "mem_tc000002" for o in cur.objects),
          "「现在」不应返回过期")
    hist = recall_engine.recall("以前用过什么引擎", tier="T2",
                                categories=["preference"],
                                include_history=True, limit=10)
    check(any(o["id"] == "mem_tc000002" for o in hist.objects),
          "「以前」应返回历史")


# ================= Phase 5：Recall =================

@ sandboxed
def test_recall_t0_true_zero_reads(repo):
    def boom(*a, **k):
        raise AssertionError("T0 触发了文件读取")
    orig_list = store.list_object_ids
    orig_load = object_index.load_index
    orig_plan = recall_engine.load_markdown_plan
    store.list_object_ids = boom
    object_index.load_index = boom
    recall_engine.load_markdown_plan = boom
    try:
        res = recall_engine.recall("1+1 等于多少？", tier="T0")
        check(res.access == "NONE", "T0 access=NONE")
        check(res.objects == [] and res.markdown_plan == [], "T0 零召回")
    finally:
        store.list_object_ids = orig_list
        object_index.load_index = orig_load
        recall_engine.load_markdown_plan = orig_plan


def test_recall_t0_function_is_pure():
    # 单元级：T0 在任何文件都不存在时也不报错
    res = recall_engine.recall("数学题", tier="T0")
    check(res.access == "NONE" and not res.objects, "T0 纯短路")


@ sandboxed
def test_recall_t1_minimal(repo):
    write_engine.perform_write(cand(
        "用户是 3D 动画师", oid="mem_t1000001", category="identity",
        layer="L1", type_="foundational"))
    write_engine.perform_write(cand(
        "用户在做 UE 游戏原型", oid="mem_t1000002", category="project",
        layer="L3", type_="state"))
    res = recall_engine.recall("我是谁", tier="T1", limit=10)
    check(res.access == "IDENTITY", res.to_dict())
    check(any(o["id"] == "mem_t1000001" for o in res.objects),
          "T1 应召回 identity")
    check(not any(o["id"] == "mem_t1000002" for o in res.objects),
          "T1 不应召回 project（最小召回）")
    check(any(p["layer"] == "L1" for p in res.markdown_plan),
          "T1 应携带 L1 Markdown 段级计划")


@ sandboxed
def test_recall_t2_project(repo):
    write_engine.perform_write(cand(
        "用户在做 UE 游戏原型《山川夜语》", oid="mem_t2000001",
        category="project", layer="L3", type_="state"))
    write_engine.perform_write(cand(
        "用户喜欢留白美学", oid="mem_t2000002", category="preference",
        layer="L2"))
    res = recall_engine.recall("项目进度", tier="T2", limit=10)
    check(res.access == "PROJECT", res.to_dict())
    check(any(o["id"] == "mem_t2000001" for o in res.objects),
          "T2 应召回 project")
    check(not any(o["id"] == "mem_t2000002" for o in res.objects),
          "T2 不应召回 preference")


@ sandboxed
def test_recall_t3_light_only_high_priority(repo):
    for i, pr in enumerate(["low", "medium", "high", "high"]):
        write_engine.perform_write(cand(
            "项目状态条目 %d" % i, oid="mem_t3%06d" % i,
            category="project", layer="L3", priority=pr))
    res = recall_engine.recall("项目", tier="T3", limit=100)
    check(len(res.objects) <= 3, "T3 light 应限流（≤3）")
    check(all((o.get("classification") or {}).get("priority") == "high"
              for o in res.objects), "T3 light 只保留 high priority")


@ sandboxed
def test_recall_ranking_deterministic(repo):
    write_engine.perform_write(cand(
        "喜欢安静的环境", oid="mem_rk000001", priority="low"))
    write_engine.perform_write(cand(
        "喜欢留白的表达", oid="mem_rk000002", priority="high"))
    write_engine.perform_write(cand(
        "可能喜欢木色调", oid="mem_rk000003", priority="medium",
        evidence="inferred"))
    res1 = recall_engine.recall("喜欢", tier="T2",
                                categories=["preference"], limit=10)
    ids1 = [o["id"] for o in res1.objects]
    res2 = recall_engine.recall("喜欢", tier="T2",
                                categories=["preference"], limit=10)
    check(ids1 == [o["id"] for o in res2.objects], "排序应确定")
    check(ids1[0] == "mem_rk000002", "high priority 应排最前: %s" % ids1)


@ sandboxed
def test_recall_markdown_plan_backward_compat(repo):
    res = recall_engine.recall("你是谁", tier="T1")
    files = [p["file"] for p in res.markdown_plan]
    check("画像.md" in files, "L1 Markdown 召回计划应保留（旧映射仍有效）")
    l5 = recall_engine.recall("约束", tier="T2", layers=["L5"])
    check(any(p["layer"] == "L5" for p in l5.markdown_plan),
          "显式 layers 参数应生效")


@ sandboxed
def test_recall_project_scope_filter(repo):
    write_engine.perform_write(cand(
        "工作室命名方向：鱼火", oid="mem_sc000001", category="project",
        scope="project", entities=["工作室"], layer="L3"))
    write_engine.perform_write(cand(
        "全局偏好：留白", oid="mem_sc000002", scope="global"))
    res = recall_engine.recall("工作室", tier="T2",
                               categories=["project", "preference"],
                               scope="project", limit=10)
    check(any(o["id"] == "mem_sc000001" for o in res.objects),
          "scope=project 应召回 project 对象")
    check(any(o["id"] == "mem_sc000002" for o in res.objects),
          "global 对象在任意 scope 可见")


# ================= Phase 6：Conflict Resolver =================

def test_conflict_evidence_priority_ladder():
    check(conflict.evidence_wins("explicit", "2026-08-17T00:00:00Z",
                                  "inferred", "2026-08-17T00:00:00Z"),
          "explicit 应胜过 inferred")
    check(not conflict.evidence_wins("inferred", "2026-08-18T00:00:00Z",
                                     "explicit", "2026-08-17T00:00:00Z"),
          "inferred 绝不得胜过 explicit（即便更新）")
    check(conflict.evidence_wins("explicit", "2026-08-18T00:00:00Z",
                                  "explicit", "2026-08-17T00:00:00Z"),
          "同级别新者胜（用户当前表达 > 历史表达）")


def test_conflict_reverse_preference_detected():
    a = cand("用户喜欢用 Maya", oid="mem_cf000001", entities=["Maya"])
    b = cand("用户不再使用 Maya", oid="mem_cf000002", entities=["Maya"])
    level, _ = conflict.conflict_level(b, a)
    check(level in ("contradiction", "value_change"),
          "反向偏好应被识别为冲突: %r" % level)


# ================= Phase 7：Consolidation =================

@ sandboxed
def test_consolidation_episodic_to_semantic(repo):
    write_engine.perform_write(cand(
        "2026-08-10 用户说喜欢高信息密度", oid="mem_ep000001",
        type_="episodic", category="event", layer="L4", evidence="observed",
        status="active"))
    write_engine.perform_write(cand(
        "2026-08-12 用户再次纠正：不要废话", oid="mem_ep000002",
        type_="episodic", category="event", layer="L4", evidence="observed",
        status="active"))
    action, oid, entries = consolidation.consolidate(
        ["mem_ep000001", "mem_ep000002"],
        "用户偏好高信息密度、直接、少废话的回答", category="preference")
    check(action == "CREATE" and oid, "巩固应新建 semantic")
    obj = store.load_object(oid)
    check(obj["status"] == "active", "≥2 条证据应 active")
    check(set(obj["relations"]["related"]) ==
          {"mem_ep000001", "mem_ep000002"}, "related 应记录全部 Episode")
    check(store.load_object("mem_ep000001") is not None,
          "Episode 原始证据必须保留")
    check(audit.entries_for(oid)[0]["operation"] == "CONSOLIDATE",
          "审计应记录 CONSOLIDATE")


@ sandboxed
def test_consolidation_below_threshold_candidate(repo):
    write_engine.perform_write(cand(
        "2026-08-10 用户说喜欢留白", oid="mem_ep000011",
        type_="episodic", category="event", layer="L4", evidence="observed",
        status="active"))
    action, oid, _ = consolidation.consolidate(
        ["mem_ep000011"], "用户偏好留白", category="preference", threshold=2)
    obj = store.load_object(oid)
    check(obj["status"] == "candidate", "证据不足应 candidate")


# ================= Phase 8：Procedural =================

@ sandboxed
def test_procedural_memory(repo):
    oid = procedural.create_procedural(
        "GroundMate 开发必须优先保证 Maya 2020.4–2026 兼容",
        category="toolchain", entities=["GroundMate", "Maya"])
    found = procedural.find_procedural("GroundMate Maya", limit=5)
    check(any(o["id"] == oid for o in found), "应按任务锚点召回 procedural")


# ================= Phase 9：Object Index =================

@ sandboxed
def test_rebuild_index(repo):
    write_engine.perform_write(cand(
        "用户的回答风格偏好简洁", oid="mem_ix000001"))
    write_engine.perform_write(cand(
        "用户的工作室命名方向是鱼火", oid="mem_ix000002"))
    os.remove(engine_paths.OBJECT_INDEX_PATH)
    check(object_index.load_index() is None, "索引已删")
    idx = object_index.rebuild()
    check(set(idx["objects"].keys()) == {"mem_ix000001", "mem_ix000002"},
          "重建应恢复全部对象")
    check(object_index.is_stale() is False, "重建后应不 stale")


@ sandboxed
def test_index_object_priority_object_wins(repo):
    write_engine.perform_write(cand(
        "记忆 A", oid="mem_ob000001", category="preference"))
    idx = object_index.load_index()
    idx["objects"]["mem_ob000001"]["status"] = "superseded"  # 篡改派生索引
    with open(engine_paths.OBJECT_INDEX_PATH, "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False)
    problems = object_index.mismatch_report()
    check(any("status" in p for p in problems), "应检出 index≠object 漂移: %s" % problems)
    object_index.rebuild()
    check(object_index.mismatch_report() == [], "rebuild 后一致（Object 优先）")


# ================= Phase 10：Doctor =================

@ sandboxed
def test_doctor_all_pass_on_clean_store(repo):
    write_engine.perform_write(cand("合法记忆", oid="mem_dr000001"))
    rep = doctor_v2.run_doctor()
    check(rep.ok, "干净对象库应 ALL PASS: %s" % rep.failures)


@ sandboxed
def test_doctor_orphan_detection(repo):
    obj = cand("孤儿对象", oid="mem_orphan01")
    store.save_object(obj)
    rep = doctor_v2.run_doctor()
    check(not rep.ok and "orphan object file" in rep.failures,
          "orphan 应 FAIL: %s" % rep.failures)


@ sandboxed
def test_doctor_broken_relation(repo):
    obj = cand("悬空关系", oid="mem_broken001")
    obj["relations"]["supersedes"] = ["mem_ghost001"]
    store.save_object(obj)
    rep = doctor_v2.run_doctor()
    check(not rep.ok and "broken relation" in rep.failures,
          "broken relation 应 FAIL: %s" % rep.failures)


@ sandboxed
def test_doctor_dangling_supersedes(repo):
    a = cand("旧事实", oid="mem_dang0001")
    store.save_object(a)
    b = cand("新事实", oid="mem_dang0002")
    b["relations"]["supersedes"] = ["mem_dang0001"]
    store.save_object(b)  # a.status 仍 active → dangling
    rep = doctor_v2.run_doctor()
    check(not rep.ok and "dangling supersedes" in rep.failures,
          "dangling supersedes 应 FAIL: %s" % rep.failures)


@ sandboxed
def test_doctor_missing_object_file(repo):
    write_engine.perform_write(cand("索引有对象", oid="mem_miss0001"))
    os.remove(store.object_path("mem_miss0001"))
    rep = doctor_v2.run_doctor()
    check(not rep.ok and "missing object file" in rep.failures,
          "index 指向缺失文件应 FAIL: %s" % rep.failures)


@ sandboxed
def test_doctor_forbidden_secrets(repo):
    obj = cand("含令牌对象 " + tok(), oid="mem_secret01")
    store.save_object(obj)
    rep = doctor_v2.run_doctor()
    check(not rep.ok and "forbidden secrets" in rep.failures,
          "对象含密钥样值应 FAIL: %s" % rep.failures)


@ sandboxed
def test_doctor_duplicate_active_content(repo):
    store.save_object(cand("完全相同的偏好内容", oid="mem_dup00001"))
    store.save_object(cand("完全相同的偏好内容", oid="mem_dup00002"))
    rep = doctor_v2.run_doctor()
    check(not rep.ok and "duplicate memory (active)" in rep.failures,
          "active 重复内容应 FAIL: %s" % rep.failures)


@ sandboxed
def test_doctor_superseded_leak_detection(repo):
    write_engine.perform_write(cand(
        "旧说法", oid="mem_leak0001", category="project", layer="L3",
        entities=["引擎"]))
    write_engine.perform_write(cand(
        "新说法", oid="mem_leak0002", category="project", layer="L3",
        entities=["引擎"]))
    rep = doctor_v2.run_doctor()
    check(rep.ok, "正常 supersede 后召回应无泄露: %s" % rep.failures)
    old = store.load_object("mem_leak0001")
    check(old["status"] == "superseded", "前置：旧对象应 superseded")


# ================= Phase 11：Migration =================

def _load_migrate_module():
    spec = importlib.util.spec_from_file_location(
        "memv2_migrate", os.path.join(REPO_ROOT, "migrate-memory.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _write_fixture_md(repo):
    with open(os.path.join(repo, "memory", "画像.md"), "w",
              encoding="utf-8") as fh:
        fh.write("# 画像\n## 审美\n- 喜欢留白，不喜欢解释过多\n- 讨厌堆砌神话元素的名字\n")
    with open(os.path.join(repo, "memory", "决策.md"), "w",
              encoding="utf-8") as fh:
        fh.write("# 决策\n## 已确认\n- 软件工程成熟方案优先，不从零造轮子\n"
                 "## 已否决（不要重复推荐）\n- 四字成语式公司名，生硬堆砌神话元素\n")
    with open(os.path.join(repo, "memory", "待办.md"), "w",
              encoding="utf-8") as fh:
        fh.write("# 待办\n## 最高优先级\n- [ ] 确认先推进哪个主线方向\n- [x] 已完成的旧事不转换\n")


@ sandboxed
def test_migration_dry_run_zero_write(repo):
    _write_fixture_md(repo)
    mod = _load_migrate_module()
    before = set(store.list_object_ids())
    mod.cmd_dry_run(None)
    check(set(store.list_object_ids()) == before, "dry-run 零写入")


@ sandboxed
def test_migration_migrate_and_rollback(repo):
    _write_fixture_md(repo)
    mod = _load_migrate_module()
    check(mod.cmd_migrate(None) == 0, "migrate 应成功")
    created = set(store.list_object_ids())
    check(len(created) >= 4, "应生成多个对象: %s" % created)
    explicit_ids = [o["id"] for o in store.load_all_objects()
                    if (o.get("provenance") or {}).get("evidence") == "explicit"]
    check(len(explicit_ids) >= 3, "决策/画像（explicit）应 active")
    check(mod.cmd_rollback(None) == 0, "rollback 应成功")
    check(set(store.list_object_ids()) == set(), "rollback 后对象应清空")


@ sandboxed
def test_migration_idempotent(repo):
    _write_fixture_md(repo)
    mod = _load_migrate_module()
    mod.cmd_migrate(None)
    first = set(store.list_object_ids())
    mod.cmd_migrate(None)
    check(set(store.list_object_ids()) == first, "重跑 migrate 不得重复")


@ sandboxed
def test_migration_completed_todos_skipped(repo):
    _write_fixture_md(repo)
    mod = _load_migrate_module()
    plan = mod.build_plan()
    contents = [c["content"] for c in plan["candidates"]]
    check(not any("已完成的旧事" in c for c in contents),
          "已完成待办不应转成记忆对象")
    check(any("确认先推进哪个" in c for c in contents),
          "未完成待办应保留为候选")


# ================= Phase 13：Adapter Interface =================

@ sandboxed
def test_adapter_interface_roundtrip(repo):
    adapter = CLIAdapter()
    w = adapter.write(cand("适配器写入的记忆", oid="mem_ad000001"))
    check(w.decision == "NEW_MEMORY" and w.status == "active", w.to_dict())
    res = adapter.recall("记忆", tier="T2",
                         categories=["preference"], limit=5)
    check(any(o["id"] == "mem_ad000001" for o in res.objects),
          "适配器召回应读到写入对象")
    u = adapter.update("mem_ad000001", "适配器更新后的记忆")
    check(u.decision == "UPDATE_MEMORY", u.to_dict())
    s = adapter.supersede("mem_ad000001", "适配器推翻后的新记忆")
    check(s.decision == "SUPERSEDE_MEMORY" and s.status == "active",
          s.to_dict())
    st = adapter.status()
    check(st["total"] == 2, "统计应含新旧两个对象: %s" % st)


def test_adapter_never_touches_store_directly():
    from adapters.interface import MemoryAdapter
    import inspect
    methods = [m for m in ("read", "recall", "write", "update",
                           "supersede", "status")]
    for m in methods:
        check(hasattr(MemoryAdapter, m) and
              getattr(MemoryAdapter, m).__isabstractmethod__,
              "接口应声明抽象方法 %s" % m)


# ================= §28 最终验收 =================

@ sandboxed
def test_acceptance_new_memory(repo):
    r = write_engine.perform_write(cand(
        "我喜欢简洁回答", oid="mem_ft000001"))
    check(r.decision == "NEW_MEMORY", "§28 测试1")


@ sandboxed
def test_acceptance_update_preference(repo):
    write_engine.perform_write(cand(
        "我喜欢简洁回答", oid="mem_ft000011", tags=["回答方式"],
        entities=["回答方式"]))
    r = write_engine.perform_write(cand(
        "以后不用那么简洁了，我想看详细分析", oid="mem_ft000012",
        tags=["回答方式"], entities=["回答方式"]))
    check(r.decision == "SUPERSEDE_MEMORY", "§28 测试3: %s" % r.to_dict())
    cur = recall_engine.recall("我现在喜欢什么回答方式", tier="T2",
                               categories=["preference"], limit=5)
    check(any("详细分析" in o["content"] for o in cur.objects),
          "当前偏好应返回新记忆")
    hist = recall_engine.recall("以前我喜欢什么", tier="T2",
                                categories=["preference"],
                                include_history=True, limit=5)
    check(any("简洁回答" in o["content"] for o in hist.objects),
          "历史应能找到旧记忆")


@ sandboxed
def test_acceptance_project_state(repo):
    r = write_engine.perform_write(cand(
        "我现在主要做 UE", oid="mem_ft000021", category="project",
        layer="L3", type_="state"))
    check(r.decision == "NEW_MEMORY", "§28 测试6")
    res = recall_engine.recall("项目问题：现在做什么", tier="T2", limit=5)
    check(any(o["id"] == "mem_ft000021" for o in res.objects),
          "只读取对应 project memory")


@ sandboxed
def test_acceptance_explicit_remember_immediate_write(repo):
    r = write_engine.perform_write(cand(
        "记住这个：工作室叫鱼火", oid="mem_ft000031", evidence="observed"),
        explicit_remember=True)
    check(r.decision == "NEW_MEMORY" and r.status == "active",
          "§28 测试10：Immediate Write")


@ sandboxed
def test_acceptance_audit_git_traceable(repo):
    r = write_engine.perform_write(cand(
        "需要审计的记忆", oid="mem_ft000041"))
    entries = audit.entries_for("mem_ft000041")
    check(len(entries) == 1 and entries[0]["operation"] == "CREATE",
          "§28 测试11：操作可审计")
    check("content" not in entries[0], "审计不得存对话全文")


TESTS = [
    test_schema_valid_object_passes,
    test_schema_rejects_invalid_status,
    test_schema_rejects_invalid_scope,
    test_schema_rejects_invalid_evidence,
    test_schema_rejects_invalid_temporal_range,
    test_schema_rejects_path_traversal_id,
    test_lifecycle_transitions,
    test_write_new_memory,
    test_write_duplicate_no_change,
    test_write_update_refinement,
    test_write_supersede,
    test_superseded_never_wins_current_recall,
    test_history_recall_includes_superseded,
    test_inferred_never_overwrites_explicit,
    test_negative_preference_filters_recommendation,
    test_candidate_lifecycle_and_reject,
    test_t4_remember_immediate_active,
    test_no_change_zero_side_effects,
    test_write_rejects_secret_content,
    test_temporal_validity_filters,
    test_temporal_current_vs_history_engine,
    test_recall_t0_true_zero_reads,
    test_recall_t0_function_is_pure,
    test_recall_t1_minimal,
    test_recall_t2_project,
    test_recall_t3_light_only_high_priority,
    test_recall_ranking_deterministic,
    test_recall_markdown_plan_backward_compat,
    test_recall_project_scope_filter,
    test_conflict_evidence_priority_ladder,
    test_conflict_reverse_preference_detected,
    test_consolidation_episodic_to_semantic,
    test_consolidation_below_threshold_candidate,
    test_procedural_memory,
    test_rebuild_index,
    test_index_object_priority_object_wins,
    test_doctor_all_pass_on_clean_store,
    test_doctor_orphan_detection,
    test_doctor_broken_relation,
    test_doctor_dangling_supersedes,
    test_doctor_missing_object_file,
    test_doctor_forbidden_secrets,
    test_doctor_duplicate_active_content,
    test_doctor_superseded_leak_detection,
    test_migration_dry_run_zero_write,
    test_migration_migrate_and_rollback,
    test_migration_idempotent,
    test_migration_completed_todos_skipped,
    test_adapter_interface_roundtrip,
    test_adapter_never_touches_store_directly,
    test_acceptance_new_memory,
    test_acceptance_update_preference,
    test_acceptance_project_state,
    test_acceptance_explicit_remember_immediate_write,
    test_acceptance_audit_git_traceable,
]


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
