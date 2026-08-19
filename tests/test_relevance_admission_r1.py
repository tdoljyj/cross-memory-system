#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MIV-005A-R1 全路由相关性准入门测试（Relevance Admission across recall routes）。

裁决要求（MIV-005A-R1，2026-08-19 产品所有者裁决 PARTIAL / CONTRACT_DEVIATION）：
 1. 默认 tier 路由：相关查询正确命中；
 2. 默认 tier 路由：无关查询正确 NO MEMORY；
 3. 显式 layers 与等价 tier-derived layers 行为一致；
 4. project_only：同项目但无关对象被阈值排除；
 5. project_only：相关对象正常命中；
 6. session_only 对应正反例；
 7. conflict loser 在所有路由中都不能复活；
 8. explain 开关、Trace reason code、显式 tags/entities selector 保持合同一致。

本文件只新增断言；既有测试的合同演进（2 项翻转 + 8 项查询调整）按
裁决在对应既有测试文件中实施，未修改任何阈值 / 评分 / 生产数据。

运行：python tests/test_relevance_admission_r1.py
"""

import functools
import json
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import recall_engine  # noqa: E402
from memory_engine import recall_trace as RT  # noqa: E402
from memory_engine import relevance as REL  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def make_repo():
    tmp = tempfile.mkdtemp(prefix="rel-r1-test-")
    memdir = os.path.join(tmp, "memory")
    os.makedirs(os.path.join(memdir, "objects"), exist_ok=True)
    os.makedirs(os.path.join(memdir, "audit"), exist_ok=True)
    idx = {
        "schema_version": 1,
        "files": ["画像.md"],
        "recall": {
            "L1": [{"file": "画像.md", "sections": ["身份轨迹"]}],
            "L2": [{"file": "画像.md", "sections": ["审美"]}],
            "L3": [{"file": "画像.md", "sections": ["技术能力"]}],
            "L4": [], "L5": [], "L6": [],
        },
    }
    with open(os.path.join(memdir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False)
    with open(os.path.join(memdir, "画像.md"), "w", encoding="utf-8") as fh:
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


def cand(content, category="preference", oid=None, tags=None, entities=None,
         layer="L2", scope="global", project_id=None, session_id=None, **kw):
    obj = S.new_object(
        oid=oid or store.new_id(), type_="semantic", content=content,
        scope=scope, status="active", category=category,
        evidence="explicit", priority="medium", recall_layer=layer,
        adapter="rel-r1", tags=tags, entities=entities,
        project_id=project_id, **kw)
    if session_id:
        obj["source"]["session_id"] = session_id
    return obj


def put(obj):
    store.save_object(obj)
    return obj["id"]


def ids(result):
    return [o["id"] for o in result.objects]


def excluded_codes(trace, oid):
    for e in (trace or {}).get("excluded", []):
        if e.get("memory_id") == oid:
            return list(e.get("reason_codes") or [])
    return []


# ============ 1. 默认 tier 路由：相关查询正确命中 ============
@ sandboxed
def test_default_tier_route_relevant_hit(_repo):
    hit = put(cand("用户在做 UE 游戏原型，项目进度已到玩法原型",
                   category="project", layer="L3", oid="mem_r1a00001"))
    put(cand("用户喜欢留白美学", category="preference", layer="L2",
             oid="mem_r1a00002"))
    r = recall_engine.recall("项目进度", tier="T2", limit=10)
    check(r.access == "PROJECT", "默认 T2 路由 access 应 PROJECT: %r"
          % r.to_dict())
    check(ids(r) == [hit],
          "默认 tier 路由相关查询必须命中: %r" % ids(r))
    check(not any(o["id"] == "mem_r1a00002" for o in r.objects),
          "T2 默认路由不应召回 preference: %r" % ids(r))


# ============ 2. 默认 tier 路由：无关查询正确 NO MEMORY ============
@ sandboxed
def test_default_tier_route_irrelevant_no_memory(_repo):
    irr = put(cand("用户在看科幻电影", category="project", layer="L3",
                   oid="mem_r1b00001"))
    r = recall_engine.recall("项目进度", tier="T2", explain=True)
    check(ids(r) == [], "默认 tier 路由无关查询必须 NO MEMORY: %r" % ids(r))
    check(RT.RC_NO_MEMORY in r.trace.get("reason_codes", []),
          "trace 顶层必须带 NO_MEMORY: %r" % r.trace.get("reason_codes"))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          in excluded_codes(r.trace, irr),
          "默认路由排除须带 RELEVANCE_BELOW_THRESHOLD: %r"
          % excluded_codes(r.trace, irr))
    check(r.skipped["relevance_below_threshold"] == 1,
          "skipped 计数: %r" % r.skipped)


# ============ 3. 显式 layers 与等价 tier-derived layers 行为一致 ============
@ sandboxed
def test_explicit_layers_equals_tier_derived(_repo):
    hit = put(cand("用户在做 UE 游戏原型，项目进度已到玩法原型",
                   category="project", layer="L3", oid="mem_r1c00001"))
    put(cand("用户在看科幻电影", category="project", layer="L3",
             oid="mem_r1c00002"))
    r_def = recall_engine.recall("项目进度", tier="T2", explain=True)
    r_exp = recall_engine.recall("项目进度", tier="T2", layers=["L3"],
                                 explain=True)
    check(r_def.layers == r_exp.layers == ["L3"],
          "默认 T2 路由解析 layers 应与显式一致: %r / %r"
          % (r_def.layers, r_exp.layers))
    check(ids(r_def) == ids(r_exp) == [hit],
          "相关查询两条路由结果必须一致: %r / %r"
          % (ids(r_def), ids(r_exp)))
    check(r_def.skipped == r_exp.skipped,
          "skipped 统计必须一致: %r / %r" % (r_def.skipped, r_exp.skipped))
    # 无关查询：两条路由都必须 NO MEMORY
    r_def_nm = recall_engine.recall("完全无关的查询", tier="T2", explain=True)
    r_exp_nm = recall_engine.recall("完全无关的查询", tier="T2",
                                    layers=["L3"], explain=True)
    check(ids(r_def_nm) == ids(r_exp_nm) == [],
          "无关查询两条路由都必须为空: %r / %r"
          % (ids(r_def_nm), ids(r_exp_nm)))
    for r in (r_def_nm, r_exp_nm):
        check(RT.RC_NO_MEMORY in r.trace.get("reason_codes", []),
              "两条路由都必须带 NO_MEMORY: %r" % r.trace.get("reason_codes"))


# ============ 4. project_only：同项目但无关对象被阈值排除 ============
@ sandboxed
def test_project_only_irrelevant_excluded(_repo):
    rel = put(cand("项目 A 使用 UE 5.6 引擎", category="project", layer="L3",
                   scope="project", project_id="p-alpha",
                   oid="mem_r1d00001"))
    irr = put(cand("项目 A 只在内部用 git", category="project", layer="L3",
                   scope="project", project_id="p-alpha",
                   oid="mem_r1d00002"))
    r = recall_engine.recall("引擎", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-alpha",
                             explain=True)
    check(ids(r) == [rel],
          "project_only 同项目相关对象命中、无关对象被阈值排除: %r"
          % ids(r))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          in excluded_codes(r.trace, irr),
          "同项目无关对象必须带 RELEVANCE_BELOW_THRESHOLD: %r"
          % excluded_codes(r.trace, irr))
    check(RT.RC_NO_MEMORY not in r.trace.get("reason_codes", []),
          "有命中时不得带 NO_MEMORY: %r" % r.trace.get("reason_codes"))
    # 全部无关 → NO MEMORY
    r2 = recall_engine.recall("完全不相关", tier="T2", layers=["L3"],
                              scope="project_only", project_id="p-alpha",
                              explain=True)
    check(ids(r2) == [], "project_only 全无关必须 NO MEMORY: %r" % ids(r2))
    check(RT.RC_NO_MEMORY in r2.trace.get("reason_codes", []),
          "project_only 全无关 trace 必须带 NO_MEMORY")
    for oid in (rel, irr):
        check(RT.RC_RELEVANCE_BELOW_THRESHOLD
              in excluded_codes(r2.trace, oid),
              "%s 必须带 RELEVANCE_BELOW_THRESHOLD" % oid)


# ============ 5. project_only：相关对象正常命中 ============
@ sandboxed
def test_project_only_relevant_hit(_repo):
    rel = put(cand("项目 A 使用 UE 5.6 引擎", category="project", layer="L3",
                   scope="project", project_id="p-alpha",
                   oid="mem_r1e00001"))
    r = recall_engine.recall("引擎", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-alpha",
                             explain=True)
    check(ids(r) == [rel], "project_only 相关对象正常命中: %r" % ids(r))
    sel = r.trace["selected"]
    check(len(sel) == 1 and sel[0]["memory_id"] == rel,
          "trace selected 应含命中对象: %r" % sel)
    codes = sel[0]["reason_codes"]
    check(RT.RC_PROJECT_OK in codes and RT.RC_SCOPE_OK in codes,
          "project_only 命中须带 PROJECT_OK + SCOPE_OK: %r" % codes)
    check(RT.RC_QUERY_MATCH in codes,
          "命中须带 QUERY_MATCH: %r" % codes)


# ============ 6. session_only 对应正反例 ============
@ sandboxed
def test_session_only_positive_and_negative(_repo):
    rel = put(cand("本会话结论：深色主题", layer="L2", scope="session",
                   session_id="s1", oid="mem_r1f00001"))
    irr = put(cand("本会话周会纪要", layer="L2", scope="session",
                   session_id="s1", oid="mem_r1f00002"))
    r = recall_engine.recall("深色主题", tier="T2", layers=["L2"],
                             scope="session_only", session_id="s1",
                             explain=True)
    check(ids(r) == [rel],
          "session_only 相关对象命中、无关对象被阈值排除: %r" % ids(r))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          in excluded_codes(r.trace, irr),
          "同会话无关对象必须带 RELEVANCE_BELOW_THRESHOLD: %r"
          % excluded_codes(r.trace, irr))
    sel = r.trace["selected"]
    check(len(sel) == 1 and RT.RC_SESSION_OK in sel[0]["reason_codes"],
          "session_only 命中须带 SESSION_OK: %r" % sel)
    r2 = recall_engine.recall("完全不相关", tier="T2", layers=["L2"],
                              scope="session_only", session_id="s1",
                              explain=True)
    check(ids(r2) == [], "session_only 全无关必须 NO MEMORY: %r" % ids(r2))
    check(RT.RC_NO_MEMORY in r2.trace.get("reason_codes", []),
          "session_only 全无关 trace 必须带 NO_MEMORY")


# ============ 7. conflict loser 在所有路由中都不能复活 ============
def _conflict_pair():
    """输家高于阈值、胜者低于阈值（contradicts，同 evidence 新者胜）。"""
    loser = cand("项目 A 使用 UE 5.6 引擎", category="project", layer="L3",
                 scope="project", project_id="p-alpha",
                 oid="mem_r1cl0001", created_at="2026-08-01T00:00:00Z")
    winner = cand("公司层面已统一到 Unity", category="project", layer="L3",
                  scope="project", project_id="p-alpha",
                  oid="mem_r1cl0002", created_at="2026-08-03T00:00:00Z")
    winner["relations"]["contradicts"] = [loser["id"]]
    winner["source"]["updated_at"] = "2026-08-05T00:00:00Z"
    return loser, winner


def _assert_loser_never_resurrects(r, loser_id, winner_id, route):
    check(ids(r) == [],
          "[%s] 冲突输家不得复活、门槛下胜者不得返回: %r" % (route, ids(r)))
    check(RT.RC_CONFLICT_LOSER in excluded_codes(r.trace, loser_id),
          "[%s] 输家必须带 CONFLICT_LOSER: %r" % (route, r.trace))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          not in excluded_codes(r.trace, loser_id),
          "[%s] 输家不得再被准入门排除（证明准入在 conflict 之后）: %r"
          % (route, excluded_codes(r.trace, loser_id)))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          in excluded_codes(r.trace, winner_id),
          "[%s] 门槛下胜者必须带 RELEVANCE_BELOW_THRESHOLD: %r"
          % (route, excluded_codes(r.trace, winner_id)))
    check(RT.RC_NO_MEMORY in r.trace.get("reason_codes", []),
          "[%s] 全部排除必须带 NO_MEMORY: %r" % (route, r.trace))


@ sandboxed
def test_conflict_loser_never_resurrects_all_routes(_repo):
    loser, winner = _conflict_pair()
    put(loser)
    put(winner)
    q = "项目 A 用 UE 引擎"
    # 路由 a：显式 layers
    ra = recall_engine.recall(q, tier="T2", layers=["L3"], explain=True)
    _assert_loser_never_resurrects(ra, loser["id"], winner["id"],
                                   "explicit-layers")
    # 路由 b：默认 tier→layer
    rb = recall_engine.recall(q, tier="T2", explain=True)
    _assert_loser_never_resurrects(rb, loser["id"], winner["id"],
                                   "default-tier")
    # 路由 c：project_only 硬隔离
    rc = recall_engine.recall(q, tier="T2", layers=["L3"],
                              scope="project_only", project_id="p-alpha",
                              explain=True)
    _assert_loser_never_resurrects(rc, loser["id"], winner["id"],
                                   "project_only")


# ============ 8a. explain 开关合同一致（默认 tier 路由） ============
@ sandboxed
def test_explain_equivalence_default_tier_route(_repo):
    hit = put(cand("用户在做 UE 游戏原型，项目进度已到玩法原型",
                   category="project", layer="L3", oid="mem_r1g00001"))
    put(cand("用户在看科幻电影", category="project", layer="L3",
             oid="mem_r1g00002"))
    kw = dict(tier="T2")
    r1 = recall_engine.recall("项目进度", **kw)
    r2 = recall_engine.recall("项目进度", explain=True, **kw)
    check(ids(r1) == ids(r2) == [hit],
          "explain 开关不得改变默认路由结果与顺序: %r / %r"
          % (ids(r1), ids(r2)))
    check([e["memory_id"] for e in r2.trace["selected"]] == [hit],
          "trace selected 与结果一致: %r" % r2.trace["selected"])
    check(r1.skipped == r2.skipped, "skipped 一致: %r / %r"
          % (r1.skipped, r2.skipped))


# ============ 8b. Trace reason code 合同一致（默认 tier 路由） ============
@ sandboxed
def test_trace_reason_codes_default_tier_route(_repo):
    hit = put(cand("用户在做 UE 游戏原型，项目进度已到玩法原型",
                   category="project", layer="L3", oid="mem_r1h00001"))
    r = recall_engine.recall("项目进度", tier="T2", explain=True)
    t = r.trace
    check(t.get("relevance_policy_version") == REL.RELEVANCE_POLICY_VERSION,
          "默认路由 trace 必须带 relevance_policy_version: %r" % t)
    check((t.get("relevance_threshold") or {}).get("value") == "1/6",
          "默认路由 trace 必须带 threshold: %r" % t)
    sel = [e for e in t["selected"] if e["memory_id"] == hit]
    check(len(sel) == 1 and
          RT.RC_QUERY_MATCH in sel[0]["reason_codes"] and
          RT.RC_CONFLICT_WINNER in sel[0]["reason_codes"] and
          RT.RC_LIMIT_WITHIN in sel[0]["reason_codes"],
          "命中 reason_codes 合同: %r" % sel)
    check(not r.trace.get("reason_codes"),
          "有命中时顶层不得带 NO_MEMORY: %r" % r.trace.get("reason_codes"))


# ============ 8c. 显式 tags/entities selector 合同一致（全路由） ============
@ sandboxed
def test_selector_bypass_consistent_all_routes(_repo):
    # 默认 tier 路由：selector 命中 → 低于阈值也放行
    # （tag「目标」不是查询「项目进度」的子串 → 无 selector 时 score=0 必被排除）
    tag_obj = put(cand("用户在看科幻电影", category="project", layer="L3",
                       tags=["目标"], oid="mem_r1i00001"))
    r_def = recall_engine.recall("项目进度", tier="T2", tags=["目标"],
                                 explain=True)
    check(ids(r_def) == [tag_obj],
          "默认路由 tags selector 命中必须放行: %r" % ids(r_def))
    r_def_no = recall_engine.recall("项目进度", tier="T2", explain=True)
    check(ids(r_def_no) == [],
          "无 selector 时同一对象必须被阈值排除: %r" % ids(r_def_no))
    # project_only 路由：entities selector 同样放行
    # （entity「里程碑」不是查询「预算」的子串 → 无 selector 时 score=0）
    ent_obj = put(cand("项目 A 只在内部用 git", category="project",
                       layer="L3", scope="project", project_id="p-alpha",
                       entities=["里程碑"], oid="mem_r1i00002"))
    r_proj = recall_engine.recall("预算", tier="T2", layers=["L3"],
                                  scope="project_only", project_id="p-alpha",
                                  entities=["里程碑"], explain=True)
    check(ids(r_proj) == [ent_obj],
          "project_only 路由 entities selector 命中必须放行: %r"
          % ids(r_proj))
    r_proj_no = recall_engine.recall("预算", tier="T2", layers=["L3"],
                                     scope="project_only",
                                     project_id="p-alpha", explain=True)
    check(ids(r_proj_no) == [],
          "project_only 无 selector 时同一对象必须被阈值排除: %r"
          % ids(r_proj_no))


TESTS = [
    test_default_tier_route_relevant_hit,
    test_default_tier_route_irrelevant_no_memory,
    test_explicit_layers_equals_tier_derived,
    test_project_only_irrelevant_excluded,
    test_project_only_relevant_hit,
    test_session_only_positive_and_negative,
    test_conflict_loser_never_resurrects_all_routes,
    test_explain_equivalence_default_tier_route,
    test_trace_reason_codes_default_tier_route,
    test_selector_bypass_consistent_all_routes,
]


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:  # noqa: BLE001
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
