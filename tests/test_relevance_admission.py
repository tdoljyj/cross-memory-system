#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MIV-005A 相关性准入门测试（Relevance Admission，Gate 2R 新增测试）。

覆盖 ADR-MIV-005A-001 冻结合同：
 1. score == 1/6 必须排除（严格 >，不做 >=）
 2. 显式 tags/entities selector 命中 → 准入门放行（score 低于阈值也返回）
 3. 空 query 且无显式 selector → NO MEMORY（Trace 顶层 reason_codes）
 4. 空 query + 显式 selector → selector 命中对象仍可返回
 5. 全部候选被准入门排除 → NO_MEMORY + 每个排除带 RELEVANCE_BELOW_THRESHOLD
 6. 默认 tier→layer 映射的非空查询不叠加准入门（Gate 2R 兼容合同）
 7. MIV-006 硬隔离 mode 的非空查询不叠加准入门（Gate 2R 兼容合同）
 8. 显式 layers 的定向召回叠加准入门
 9. explain=True/False 的 selected IDs 与顺序完全一致
 10. Trace 新增 relevance_policy_version / threshold 与比较方式
 11. 准入门在 conflict 之后：冲突输家按 CONFLICT_LOSER 排除，
     门槛下的胜者按 RELEVANCE_BELOW_THRESHOLD 排除
 12. threshold 对所有类别一致（无按类别的特殊阈值）
 13. 被准入门排除的候选内容/秘密零泄漏（excluded 只含 memory_id + codes）
 14. 准入门不改变排序（全部准入时顺序与既有排序一致）
 15. skipped.relevance_below_threshold 计数正确

运行：python tests/test_relevance_admission.py
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


def tok(prefix="ghp_"):
    return prefix + "A" * 32


def make_repo():
    tmp = tempfile.mkdtemp(prefix="rel-test-")
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
         layer="L2", scope="global", project_id=None, **kw):
    obj = S.new_object(
        oid=oid or store.new_id(), type_="semantic", content=content,
        scope=scope, status="active", category=category,
        evidence="explicit", priority="medium", recall_layer=layer,
        adapter="rel-test", tags=tags, entities=entities,
        project_id=project_id, **kw)
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


# ============ 1. 严格大于：== 1/6 必须排除 ============
@ sandboxed
def test_threshold_strict_equal_excluded(_repo):
    # 2/12 重叠 == 1/6 → 排除；4/12 重叠 > 1/6 → 准入
    at = put(cand("用户喜欢看科幻电影", oid="mem_relat0000"))
    above = put(cand("用户最喜欢看科幻电影", oid="mem_relabove0"))
    r = recall_engine.recall("用户最喜欢的编程语言是什么", tier="T2",
                             layers=["L2"], explain=True)
    check(ids(r) == [above], "==1/6 必须排除、>1/6 必须保留: %r" % ids(r))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD in excluded_codes(r.trace, at),
          "==1/6 排除须带 RELEVANCE_BELOW_THRESHOLD: %r" % r.trace)


# ============ 2. 显式 selector 命中放行 ============
@ sandboxed
def test_selector_hit_bypasses_threshold(_repo):
    t = put(cand("完全无关的候选内容", tags=["选择器"], oid="mem_reltag000"))
    e = put(cand("另一个无关候选", entities=["实体"], oid="mem_relent000"))
    r1 = recall_engine.recall("查询", tier="T2", layers=["L2"],
                              tags=["选择器"], explain=True)
    check(ids(r1) == [t], "tags selector 命中必须放行: %r" % ids(r1))
    r2 = recall_engine.recall("查询", tier="T2", layers=["L2"],
                              entities=["实体"], explain=True)
    check(ids(r2) == [e], "entities selector 命中必须放行: %r" % ids(r2))


# ============ 3. 空 query 且无显式 selector → NO MEMORY ============
@ sandboxed
def test_empty_query_no_selector_no_memory(_repo):
    put(cand("用户喜欢看科幻电影", oid="mem_relempty0"))
    r = recall_engine.recall("", tier="T2", layers=["L2"], explain=True)
    check(ids(r) == [], "空 query 无 selector 必须 NO MEMORY: %r" % ids(r))
    check(RT.RC_NO_MEMORY in r.trace.get("reason_codes", []),
          "trace 顶层 reason_codes 必须含 NO_MEMORY: %r" % r.trace)
    codes = excluded_codes(r.trace, "mem_relempty0")
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD in codes,
          "空 query 排除须带 RELEVANCE_BELOW_THRESHOLD: %r" % codes)
    # 默认层路由（不显式传 layers）同样适用该规则
    r2 = recall_engine.recall("", tier="T2")
    check(ids(r2) == [], "空 query 在默认层路由下也必须 NO MEMORY")


# ============ 4. 空 query + 显式 selector → 放行命中对象 ============
@ sandboxed
def test_empty_query_with_selector_admits(_repo):
    t = put(cand("候选内容", tags=["选择器"], oid="mem_relempsel"))
    r = recall_engine.recall("", tier="T2", layers=["L2"],
                             tags=["选择器"], explain=True)
    check(ids(r) == [t], "空 query + selector 命中应返回: %r" % ids(r))


# ============ 5. 全部候选被排除 → NO_MEMORY ============
@ sandboxed
def test_all_candidates_below_threshold_no_memory(_repo):
    a = put(cand("甲内容", oid="mem_relall000"))
    b = put(cand("乙内容", oid="mem_relall001"))
    r = recall_engine.recall("完全无关的查询甲乙", tier="T2", layers=["L2"],
                             explain=True)
    check(ids(r) == [], "全部低于阈值必须 NO MEMORY")
    check(RT.RC_NO_MEMORY in r.trace.get("reason_codes", []),
          "trace 必须带 NO_MEMORY: %r" % r.trace)
    for oid in (a, b):
        check(RT.RC_RELEVANCE_BELOW_THRESHOLD
              in excluded_codes(r.trace, oid),
              "%s 必须带 RELEVANCE_BELOW_THRESHOLD" % oid)
    check(r.skipped["relevance_below_threshold"] == 2,
          "skipped 计数: %r" % r.skipped)


# ============ 6/7/8. 适用边界（Gate 2R 兼容合同） ============
@ sandboxed
def test_gate_not_applied_default_tier_layers(_repo):
    put(cand("用户在做 UE 游戏原型《山川夜语》", category="project",
             layer="L3", oid="mem_reldef000"))
    r = recall_engine.recall("项目进度", tier="T2")
    check(ids(r) == ["mem_reldef000"],
          "默认 tier→layer 路由不叠加准入门: %r" % ids(r))


@ sandboxed
def test_gate_not_applied_new_scope_modes(_repo):
    a = put(cand("项目 A 使用 UE 5.6 引擎", category="project", layer="L3",
                 scope="project", project_id="p-alpha",
                 oid="mem_relproja0"))
    g = put(cand("所有项目统一使用 git", category="project", layer="L3",
                 oid="mem_relprojg0"))
    r = recall_engine.recall("引擎", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-alpha",
                             explain=True)
    got = set(ids(r))
    check(a in got and g in got,
          "MIV-006 硬隔离 mode 不叠加准入门（分区合同可见性不变）: %r" % got)


@ sandboxed
def test_gate_applied_explicit_layers(_repo):
    put(cand("用户在做 UE 游戏原型《山川夜语》", category="project",
             layer="L3", oid="mem_relexpl00"))
    r = recall_engine.recall("项目进度", tier="T2", layers=["L3"],
                             explain=True)
    check(ids(r) == [], "显式 layers 定向召回必须叠加准入门: %r" % ids(r))
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          in excluded_codes(r.trace, "mem_relexpl00"),
          "排除须带 RELEVANCE_BELOW_THRESHOLD")


# ============ 9. explain 等价性 ============
@ sandboxed
def test_explain_equivalence_with_gate(_repo):
    put(cand("用户喜欢看科幻电影", oid="mem_releq0000"))
    put(cand("用户最喜欢看科幻电影", oid="mem_releq0001"))
    kw = dict(tier="T2", layers=["L2"])
    r1 = recall_engine.recall("用户最喜欢的编程语言是什么", **kw)
    r2 = recall_engine.recall("用户最喜欢的编程语言是什么", explain=True,
                              **kw)
    check(ids(r1) == ids(r2) == ["mem_releq0001"],
          "explain 开关不得改变准入门结果与顺序: %r / %r"
          % (ids(r1), ids(r2)))


# ============ 10. Trace 合同新增字段 ============
@ sandboxed
def test_trace_relevance_policy_fields(_repo):
    put(cand("用户喜欢看科幻电影", oid="mem_relpol000"))
    r = recall_engine.recall("用户最喜欢的编程语言是什么", tier="T2",
                             layers=["L2"], explain=True)
    t = r.trace
    check(t.get("relevance_policy_version") == REL.RELEVANCE_POLICY_VERSION,
          "trace 必须带 relevance_policy_version: %r" % t)
    thr = t.get("relevance_threshold") or {}
    check(thr.get("value") == "1/6", "threshold.value 必须为 1/6: %r" % thr)
    check("strict" in (thr.get("comparison") or ""),
          "comparison 必须声明严格大于: %r" % thr)
    check("tags" in (thr.get("selector_bypass") or [])
          and "entities" in (thr.get("selector_bypass") or []),
          "selector_bypass 必须含 tags/entities: %r" % thr)
    # 空 Trace 路径（T0）同样携带该合同字段
    t0 = recall_engine.recall("任何查询", tier="T0", explain=True).trace
    check(t0.get("relevance_policy_version") == REL.RELEVANCE_POLICY_VERSION,
          "T0 trace 同样携带 relevance_policy_version")
    check((t0.get("relevance_threshold") or {}).get("value") == "1/6",
          "T0 trace 同样携带 threshold")


# ============ 11. 准入门在 conflict 之后 ============
@ sandboxed
def test_conflict_before_gate_loser_and_threshold(_repo):
    a = cand("用户喜欢静态类型语言", tags=["语言", "类型"],
             oid="mem_relcfa000", created_at="2026-08-01T00:00:00Z")
    b = cand("用户现在的首选语言是 Python", entities=["Python"],
             oid="mem_relcfb000", created_at="2026-08-01T00:00:00Z")
    b["relations"]["contradicts"] = ["mem_relcfa000"]
    b["source"]["updated_at"] = "2026-08-05T00:00:00Z"  # 同 evidence 新者胜
    put(a)
    put(b)
    r = recall_engine.recall("用户喜欢静态还是动态类型？", tier="T2",
                             layers=["L2"], explain=True)
    check(ids(r) == [], "冲突输家（超过阈值）与门槛下胜者均不得返回: %r"
          % ids(r))
    check(RT.RC_CONFLICT_LOSER in excluded_codes(r.trace, "mem_relcfa000"),
          "冲突输家必须带 CONFLICT_LOSER: %r" % r.trace)
    check(RT.RC_RELEVANCE_BELOW_THRESHOLD
          in excluded_codes(r.trace, "mem_relcfb000"),
          "门槛下胜者必须带 RELEVANCE_BELOW_THRESHOLD")
    check(RT.RC_NO_MEMORY in r.trace.get("reason_codes", []),
          "全部排除必须带 NO_MEMORY")


# ============ 12. threshold 对所有类别一致 ============
@ sandboxed
def test_threshold_uniform_across_categories(_repo):
    p = put(cand("用户偏好深色主题界面", category="preference",
                 oid="mem_relunip00"))
    c = put(cand("用户约束禁止深色主题", category="constraint", layer="L5",
                 oid="mem_relunic00"))
    r = recall_engine.recall("用户的星座是什么", tier="T2",
                             layers=["L2", "L5"], explain=True)
    check(ids(r) == [], "不同类别同分（≤1/6）一律排除，无特殊阈值: %r"
          % ids(r))
    for oid in (p, c):
        check(RT.RC_RELEVANCE_BELOW_THRESHOLD
              in excluded_codes(r.trace, oid),
              "%s 必须带 RELEVANCE_BELOW_THRESHOLD" % oid)


# ============ 13. 被排除候选零内容/秘密泄漏 ============
@ sandboxed
def test_gated_candidate_content_never_leaks(_repo):
    secret = tok()
    put(cand("令牌 %s 的低分候选" % secret, oid="mem_relsec000"))
    r = recall_engine.recall("完全无关的查询", tier="T2", layers=["L2"],
                             explain=True)
    payload = json.dumps(r.trace, ensure_ascii=False)
    check(secret not in payload, "trace 不得包含被排除候选的内容/秘密")
    for e in r.trace["excluded"]:
        check(set(e.keys()) <= {"memory_id", "reason_codes"},
              "excluded 条目只允许 memory_id + reason_codes: %r" % e)


# ============ 14. 准入门不改变排序 ============
@ sandboxed
def test_gate_does_not_change_ranking(_repo):
    put(cand("表格输出结论", oid="mem_relrank00"))
    put(cand("表格输出", oid="mem_relrank01"))
    put(cand("表格", oid="mem_relrank02"))
    r = recall_engine.recall("表格输出结论", tier="T2", layers=["L2"])
    check(ids(r) == ["mem_relrank00", "mem_relrank01", "mem_relrank02"],
          "全部准入时排序与既有打分排序一致: %r" % ids(r))


# ============ 15. skipped 计数 ============
@ sandboxed
def test_skipped_relevance_counter(_repo):
    put(cand("用户喜欢看科幻电影", oid="mem_relskip00"))
    put(cand("用户最喜欢看科幻电影", oid="mem_relskip01"))
    r = recall_engine.recall("用户最喜欢的编程语言是什么", tier="T2",
                             layers=["L2"])
    check(r.skipped["relevance_below_threshold"] == 1,
          "skipped.relevance_below_threshold 应为 1: %r" % r.skipped)


TESTS = [
    test_threshold_strict_equal_excluded,
    test_selector_hit_bypasses_threshold,
    test_empty_query_no_selector_no_memory,
    test_empty_query_with_selector_admits,
    test_all_candidates_below_threshold_no_memory,
    test_gate_not_applied_default_tier_layers,
    test_gate_not_applied_new_scope_modes,
    test_gate_applied_explicit_layers,
    test_explain_equivalence_with_gate,
    test_trace_relevance_policy_fields,
    test_conflict_before_gate_loser_and_threshold,
    test_threshold_uniform_across_categories,
    test_gated_candidate_content_never_leaks,
    test_gate_does_not_change_ranking,
    test_skipped_relevance_counter,
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
