#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Memory Eval 框架测试（MIV-001 / Gate 1 新增测试）。

覆盖：schema 100% 有效 / 配额 / 夹具合法 / 语料无秘密 / 确定性回放 /
真实记忆零触碰 / 引擎路径还原 / 负例 / 未知夹具 / 失败样本无秘密。

运行：python tests/test_memory_eval.py
"""

import json
import os
import re
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_eval import corpus as corpus_mod  # noqa: E402
from memory_eval import runner  # noqa: E402
from memory_eval import schema as eval_schema  # noqa: E402
from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import schema as S  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _all_repo_objects():
    d = os.path.join(REPO_ROOT, "memory", "objects")
    return sorted(os.listdir(d))


def test_corpus_all_cases_valid():
    cases = corpus_mod.CASES
    check(len(cases) >= 100, "语料必须 ≥100（实际 %d）" % len(cases))
    bad = []
    for i, case in enumerate(cases):
        ok, errors = eval_schema.validate_case(case, i)
        if not ok:
            bad.append((case.get("case_id"), errors))
    check(not bad, "存在非法 case: %s" % (bad,))
    # case_id 唯一
    ids = [c["case_id"] for c in cases]
    check(len(ids) == len(set(ids)), "case_id 必须唯一")


def test_category_quotas_met():
    from collections import Counter
    cnt = Counter(c["category"] for c in corpus_mod.CASES)
    for cat, quota in eval_schema.CATEGORY_MIN_QUOTA.items():
        check(cnt.get(cat, 0) >= quota,
              "类别 %s 需 ≥%d（实际 %d）" % (cat, quota, cnt.get(cat, 0)))


def test_fixtures_all_valid_and_no_collision():
    fixtures = runner.load_fixtures()
    check(len(fixtures) >= 80, "夹具数量异常: %d" % len(fixtures))
    for fid, obj in fixtures.items():
        ok, errors = S.validate_object(obj)
        check(ok, "夹具 %s 非法: %s" % (fid, errors))
    # 夹具 id 不得与真实记忆对象碰撞
    real = set(_all_repo_objects())
    for fid in fixtures:
        check((fid + ".json") not in real,
              "夹具 id 与真实对象碰撞: %s" % fid)


def test_corpus_and_fixtures_contain_no_secrets():
    guards = json.load(open(os.path.join(REPO_ROOT, "guards.json"),
                            encoding="utf-8"))
    pats = guards["secret_patterns"]
    # 仓库源文件（corpus.py / fixtures.json）不得出现可被扫描模式命中的
    # 字面样值；秘密样值必须运行时拼接（FAKE_TOKEN）。
    src_files = [
        os.path.join(REPO_ROOT, "memory_eval", "corpus.py"),
        os.path.join(REPO_ROOT, "tests", "fixtures", "memory_eval",
                     "fixtures.json"),
        os.path.join(REPO_ROOT, "memory_eval", "runner.py"),
    ]
    for f in src_files:
        blob = open(f, encoding="utf-8").read()
        for p in pats:
            check(not re.search(p, blob), "%s 命中秘密模式: %s" % (f, p))
    # 构造出来的 FAKE_TOKEN 本身必须能被 guards 模式识别（证明它是有效样值）
    check(re.search(pats[0], corpus_mod.FAKE_TOKEN) is not None,
          "FAKE_TOKEN 必须能被扫描模式识别")


def test_runner_deterministic_replay():
    rep1 = runner.run_all(warmup=True)
    rep2 = runner.run_all(warmup=True)
    check(rep1["replay_hash"] == rep2["replay_hash"],
          "两次运行 replay hash 必须一致")
    m1, m2 = rep1["metrics"], rep2["metrics"]
    for key in ("precision_at5", "critical_memory_recall",
                "false_recall_rate", "current_scope_leakage_count",
                "project_only_capability_gap_count",
                "superseded_leakage_count", "no_memory_correctness",
                "cross_agent_consistency"):
        check(m1.get(key) == m2.get(key), "指标 %s 两次不一致" % key)
    check(rep1["corpus_hash"] == rep2["corpus_hash"], "corpus hash 稳定")
    check(rep1["corpus_hash"] == corpus_mod.corpus_hash(),
          "corpus hash 与语料一致")


def test_runner_never_touches_real_memory():
    before = _all_repo_objects()
    before_idx = None
    idx_path = os.path.join(REPO_ROOT, "memory", "object-index.json")
    if os.path.isfile(idx_path):
        before_idx = open(idx_path, "rb").read()
    runner.run_all(warmup=True)
    after = _all_repo_objects()
    check(before == after, "评测不得改变真实 objects 目录")
    if before_idx is not None:
        after_idx = open(idx_path, "rb").read()
        check(before_idx == after_idx, "评测不得改变 object-index.json")
    check(os.path.abspath(engine_paths.REPO) ==
          os.path.abspath(REPO_ROOT), "评测后引擎路径必须还原")


def test_invalid_cases_rejected():
    bad = [
        {"case_id": "", "category": "temporal", "now": "2026-01-01T00:00:00Z",
         "agent_id": "a", "scope": {"mode": "current"},
         "fixtures": ["x"], "query": "q", "expected_relevant_ids": [],
         "forbidden_ids": [], "expected_no_memory": True},
        {"case_id": "x", "category": "nope", "now": "2026-01-01T00:00:00Z",
         "agent_id": "a", "scope": {"mode": "current"},
         "fixtures": ["x"], "query": "q", "expected_relevant_ids": [],
         "forbidden_ids": [], "expected_no_memory": True},
        {"case_id": "x", "category": "temporal", "now": "not-a-time",
         "agent_id": "a", "scope": {"mode": "current"},
         "fixtures": ["x"], "query": "q", "expected_relevant_ids": [],
         "forbidden_ids": [], "expected_no_memory": True},
        {"case_id": "x", "category": "temporal", "now": "2026-01-01T00:00:00Z",
         "agent_id": "a", "scope": {"mode": "galaxy"},
         "fixtures": ["x"], "query": "q", "expected_relevant_ids": [],
         "forbidden_ids": [], "expected_no_memory": True},
        {"case_id": "x", "category": "temporal", "now": "2026-01-01T00:00:00Z",
         "agent_id": "a", "scope": {"mode": "current"},
         "fixtures": [], "query": "q", "expected_relevant_ids": [],
         "forbidden_ids": [], "expected_no_memory": True},
        {"case_id": "x", "category": "temporal", "now": "2026-01-01T00:00:00Z",
         "agent_id": "a", "scope": {"mode": "current"},
         "fixtures": ["x"], "query": "q", "expected_relevant_ids": [],
         "forbidden_ids": [], "expected_no_memory": True,
         "critical_assertions": ["unknown_assert"]},
    ]
    for i, case in enumerate(bad):
        ok, errors = eval_schema.validate_case(case, i)
        check(not ok, "负例 %d 应被拒绝: %s" % (i, errors))


def test_unknown_fixture_raises():
    case = {
        "case_id": "tmp-unknown-fixture", "category": "temporal",
        "now": "2026-08-18T12:00:00Z", "agent_id": "a",
        "scope": {"mode": "current"}, "fixtures": ["mem_not_exist"],
        "query": "q", "expected_relevant_ids": [],
        "forbidden_ids": [], "expected_no_memory": True,
    }
    fixtures = runner.load_fixtures()
    try:
        runner.materialize(case, fixtures)
        check(False, "未知夹具应抛 ValueError")
    except ValueError:
        pass
    finally:
        engine_paths.set_repo(REPO_ROOT)


def test_failure_samples_never_leak_markers():
    rep = runner.run_all(warmup=True)
    blob = json.dumps(rep, ensure_ascii=False, sort_keys=True)
    check(corpus_mod.FAKE_TOKEN not in blob,
          "评测结果不得包含秘密样值")
    for v in rep["verdicts"]:
        if v["case_id"] == "sa-004":
            check(v["returned_ids"] == ["mem_fx0h0003"],
                  "sa-004 应召回夹具对象本身")
            check(corpus_mod.FAKE_TOKEN not in
                  json.dumps(v, ensure_ascii=False),
                  "sa-004 verdict 不得泄漏 marker")
    check(rep["secret_leaks"] == [], "secret_leaks 必须为空")


def test_scope_metric_split_contract():
    """scope 指标拆分不变量：既有 current-scope 边界泄漏 = 0；
    project_id 隔离缺口 = 0（MIV-006 已实现硬隔离，ADR-MIV-006-001 D7）。"""
    rep = runner.run_all(warmup=True)
    m = rep["metrics"]
    check(m["current_scope_leakage_count"] == 0,
          "既有 global/project/session 边界不得泄漏（current-scope 须为 0）: %r" % m)
    check(m["project_only_capability_gap_count"] == 0,
          "MIV-006 后 project_id 隔离缺口须为 0: %r" % m)


def test_scope_mapping_contract():
    """case scope → 引擎参数（MIV-006：project_only 携带 project_id）。"""
    check(eval_schema.scope_to_engine({"mode": "current"}) == (None, None),
          "current → (None, None)")
    check(eval_schema.scope_to_engine(
        {"mode": "project_only", "project_id": "p-alpha"})
        == ("project_only", "p-alpha"),
          "project_only → (project_only, project_id)")
    check(eval_schema.scope_to_engine({"mode": "global"}) == ("global", None),
          "global → (global, None)")


def test_token_estimator_and_trace_present():
    rep = runner.run_all(warmup=True)
    with_trace = [v for v in rep["verdicts"]
                  if v["returned_ids"] and v["trace_digest"]]
    check(len(with_trace) > 0, "非空召回必须有 trace_digest")
    for v in with_trace:
        check(len(v["trace_digest"]) == 64, "trace_digest 应为 sha256 hex")


def test_report_markdown_renders():
    rep = runner.run_all(warmup=True)
    md = runner.render_markdown(rep)
    check("# Memory Eval Baseline Report" in md, "标题存在")
    check("## 指标" in md, "指标段存在")
    check("## 失败/差距样本" in md, "失败样本段存在")
    check("corpus hash" in md, "corpus hash 呈现")
    # 失败样本不得包含 fixture 内容正文（只含 ID）
    check(corpus_mod.FAKE_TOKEN not in md, "报告不得泄漏秘密")


# ============ MIV-005A：指标合同 v2.0（仅新增，v1 断言全部保留） ============

def test_metric_contract_v2_present():
    """metric_contract_version=2.0；v2 字段存在；v1 字段顶层继续输出并标记 legacy_v1。"""
    rep = runner.run_all(warmup=True)
    check(rep["metric_contract_version"] == 2.0,
          "metric_contract_version 必须为 2.0: %r" % rep.get("metric_contract_version"))
    m = rep["metrics"]
    for key in ("precision_at5_v2", "hit_rate_at5",
                "false_recall_rate_v2", "critical_memory_recall_v2"):
        check(key in m, "缺少 v2 指标 %s" % key)
    check(m.get("metric_contract_version") == 2.0,
          "metrics.metric_contract_version 必须为 2.0")
    for key in ("precision_at5", "critical_memory_recall", "false_recall_rate"):
        check(key in m, "v1 指标 %s 必须继续输出" % key)
    check(isinstance(m.get("legacy_v1"), dict), "legacy_v1 标记必须存在")
    check(isinstance(m.get("legacy_v1_fields"), list), "legacy_v1_fields 必须存在")
    check(m["legacy_v1"].get("precision_at5") == m.get("precision_at5"),
          "legacy_v1 与顶层 v1 值必须一致（同一计算产出）")
    check("slices" in m and "non_paraphrase" in m["slices"],
          "必须输出非 paraphrase 切片")


def test_miv005a_no_memory_contract():
    """MIV-005A 验收：NO MEMORY 41/41，correctness=1.0，violations=0；nm-002/nm-006 空结果。"""
    rep = runner.run_all(warmup=True)
    m = rep["metrics"]
    nm = [v for v in rep["verdicts"] if v["no_memory_expected"]]
    check(len(nm) == 41, "NO MEMORY 用例应为 41（实际 %d）" % len(nm))
    check(m["no_memory_correctness"] == 1.0,
          "no_memory_correctness 必须为 1.0: %r" % m["no_memory_correctness"])
    check(m["no_memory_violations"] == 0,
          "no_memory_violations 必须为 0: %r" % m["no_memory_violations"])
    for cid in ("nm-002", "nm-006"):
        v = next(x for x in rep["verdicts"] if x["case_id"] == cid)
        check(v["returned_ids"] == [], "%s 必须返回空结果: %r" % (cid, v["returned_ids"]))


def test_miv005a_expected_metrics_frozen_contract():
    """MIV-005A 验收口径（冻结语料/夹具，指标预期值固定）。"""
    rep = runner.run_all(warmup=True)
    m = rep["metrics"]
    np_ = m["slices"]["non_paraphrase"]
    pp_ = m["slices"]["paraphrase"]
    check(np_["precision_at5_v2"] == 1.0000,
          "非 paraphrase precision_at5_v2 必须为 1.0000: %r" % np_["precision_at5_v2"])
    check(np_["false_recall_rate_v2"] == 0.0000,
          "非 paraphrase false_recall_rate_v2 必须为 0.0000: %r" % np_["false_recall_rate_v2"])
    check(np_["critical_memory_recall_v2"] == 0.9063,
          "非 paraphrase critical recall 必须为 0.9063（58/64）: %r"
          % np_["critical_memory_recall_v2"])
    check(np_["golden_ids"] == 64 and np_["returned_objects"] == 58,
          "非 paraphrase golden 64 / 返回 58: %r" % np_)
    check(np_["hit_rate_at5"] == 0.9483,
          "非 paraphrase hit_rate_at5 必须为 0.9483（55/58）: %r" % np_["hit_rate_at5"])
    check(m["precision_at5_v2"] == 0.6556,
          "全语料 precision_at5_v2 必须为 0.6556: %r" % m["precision_at5_v2"])
    check(m["false_recall_rate_v2"] == 0.3444,
          "全语料 false_recall_rate_v2 必须为 0.3444: %r" % m["false_recall_rate_v2"])
    check(m["critical_memory_recall_v2"] == 0.7763,
          "全语料 critical recall 必须为 0.7763（59/76）: %r"
          % m["critical_memory_recall_v2"])
    check(m["golden_ids"] == 76, "全语料 golden 应为 76: %r" % m["golden_ids"])
    # paraphrase：1/12 PASS、11/12 FAIL（golden 命中即 PASS）
    pp_verdicts = [v for v in rep["verdicts"] if v["category"] == "paraphrase"]
    check(len(pp_verdicts) == 12, "paraphrase 应为 12 例")
    pp_pass = [v["case_id"] for v in pp_verdicts
               if not v["critical_failures"] and not v["missed"]]
    check(len(pp_pass) == 1, "paraphrase 必须 1/12 PASS: %r" % pp_pass)
    check(pp_["critical_memory_recall_v2"] == 0.0833,
          "paraphrase critical recall 应为 0.0833（1/12）: %r"
          % pp_["critical_memory_recall_v2"])


def test_miv005a_leakages_still_zero():
    """MIV-005A 不引入任何泄漏：scope/project/superseded/stale/secret 全部 0。"""
    rep = runner.run_all(warmup=True)
    m = rep["metrics"]
    check(m["current_scope_leakage_count"] == 0,
          "current-scope 泄漏必须为 0: %r" % m["current_scope_leakage_count"])
    check(m["project_only_capability_gap_count"] == 0,
          "project_only 隔离缺口必须为 0")
    check(m["superseded_leakage_count"] == 0,
          "superseded 泄漏必须为 0")
    check(m["stale_recall_rate"] == 0.0,
          "stale recall 必须为 0.0: %r" % m["stale_recall_rate"])
    check(rep["secret_leaks"] == [], "secret_leaks 必须为空")


def test_miv005a_token_p95_within_budget():
    """token P95 不增加且 ≤650（冻结口径上限）。"""
    rep = runner.run_all(warmup=True)
    p95 = rep["metrics"].get("estimated_prompt_tokens_p95")
    check(p95 is not None and p95 <= 650,
          "token P95 必须 ≤650: %r" % p95)


def test_miv005a_gate_reason_codes_observable():
    """非 paraphrase 中被准入门过滤的 6 个正确 ID 在 Trace 中带
    RELEVANCE_BELOW_THRESHOLD（全局 recall 64→58 的已接受下降量）。"""
    rep = runner.run_all(warmup=True)
    gated = 0
    for v in rep["verdicts"]:
        if v["category"] == "paraphrase":
            continue
        for codes in v.get("reason_codes", {}).values():
            if "RELEVANCE_BELOW_THRESHOLD" in codes:
                gated += 1
    check(gated == 6, "非 paraphrase 应有 6 个正确 ID 被准入门过滤: %r" % gated)


TESTS = [
    test_corpus_all_cases_valid,
    test_category_quotas_met,
    test_fixtures_all_valid_and_no_collision,
    test_corpus_and_fixtures_contain_no_secrets,
    test_runner_deterministic_replay,
    test_runner_never_touches_real_memory,
    test_invalid_cases_rejected,
    test_unknown_fixture_raises,
    test_failure_samples_never_leak_markers,
    test_scope_metric_split_contract,
    test_scope_mapping_contract,
    test_token_estimator_and_trace_present,
    test_report_markdown_renders,
    # ---- MIV-005A v2（v1 断言全部保留）----
    test_metric_contract_v2_present,
    test_miv005a_no_memory_contract,
    test_miv005a_expected_metrics_frozen_contract,
    test_miv005a_leakages_still_zero,
    test_miv005a_token_p95_within_budget,
    test_miv005a_gate_reason_codes_observable,
]


def main():
    failures = 0
    skipped = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:  # noqa: BLE001
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s), %d skipped" % (len(TESTS), failures, skipped))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
