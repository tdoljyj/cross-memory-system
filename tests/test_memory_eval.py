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
    project_id 隔离缺口 = 1（ps-010，MIV-006 能力，非既有 scope 越权）。"""
    rep = runner.run_all(warmup=True)
    m = rep["metrics"]
    check(m["current_scope_leakage_count"] == 0,
          "既有 global/project/session 边界不得泄漏（current-scope 须为 0）: %r" % m)
    check(m["project_only_capability_gap_count"] == 1,
          "ps-010 应为 MIV-006 project_id 能力缺口（=1），非既有 scope 越权: %r" % m)


def test_scope_mapping_contract():
    check(eval_schema.scope_to_engine({"mode": "current"}) is None,
          "current → None")
    check(eval_schema.scope_to_engine({"mode": "project_only"}) == "project",
          "project_only → project")
    check(eval_schema.scope_to_engine({"mode": "global"}) == "global",
          "global → global")


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
