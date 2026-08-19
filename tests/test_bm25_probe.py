# -*- coding: utf-8 -*-
"""MIV-005B BM25 词法可行性探针测试（纯标准库轻量 runner，无第三方依赖）。

冻结探针合同（数值来自 2026-08-19 首次审计实测，用于锁定证据稳定）：
    - 111 个冻结 case 全覆盖；
    - paraphrase 12 例中 10 例正确 ID 完全零重叠（pp-004 仅 1 个共享
      token、pp-011 4 个）；全语料 111 例中「正确 ID 全部零重叠」11 例
      （10 个 paraphrase + ps-016）；
    - 被 MIV-005A 过滤的 6 个正确 ID：4 个 BM25 score=0（零重叠无有效
      分数），mem_fx0c0003（ps-007）与 mem_fx0f0011（cs-008）各 1 个
      共享 token、rank=1；
    - 假设策略（纯 BM25、无准入门、保留 T0 零读取短路）指标：
      precision_at5_v2=0.71、critical_memory_recall_v2=0.9342、
      false_recall_rate_v2=0.29、NO MEMORY 39/41、泄漏 0 —— 全部门槛
      未达成（all_thresholds_met = False）；
    - 确定性重放 hash 两次运行完全一致；输出零正文泄漏。

运行：python tests/test_bm25_probe.py
"""

import functools
import hashlib
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_eval import bm25_probe  # noqa: E402
from memory_eval import corpus as corpus_mod  # noqa: E402
from memory_eval import runner  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


@functools.lru_cache(maxsize=1)
def probe_report():
    return bm25_probe.run_probe()


def test_probe_deterministic_replay():
    r1 = probe_report()
    r2 = bm25_probe.run_probe()
    check(r1["replay_hash"] == r2["replay_hash"],
          "两次运行 replay hash 必须一致: %r vs %r"
          % (r1["replay_hash"], r2["replay_hash"]))
    b1 = json.dumps(r1, ensure_ascii=False, sort_keys=True)
    b2 = json.dumps(r2, ensure_ascii=False, sort_keys=True)
    check(b1 == b2, "两次运行 report 必须逐字节一致")
    check(hashlib.sha256(b1.encode("utf-8")).hexdigest()
          == hashlib.sha256(b2.encode("utf-8")).hexdigest(),
          "canonical json hash 必须一致")


def test_probe_covers_all_frozen_cases():
    r = probe_report()
    check(r["case_count"] == 111, "必须覆盖全部 111 个冻结 case: %d"
          % r["case_count"])
    got = {row["case_id"] for row in r["rows"]}
    want = {c["case_id"] for c in corpus_mod.CASES}
    check(got == want, "case_id 集合必须与冻结语料一致: 缺 %s 多 %s"
          % (sorted(want - got), sorted(got - want)))
    check(r["corpus_hash"] == corpus_mod.corpus_hash(),
          "probe 必须基于同一冻结语料 hash")


def test_paraphrase_zero_overlap_frozen():
    r = probe_report()
    check(r["paraphrase_zero_overlap_count"] == 10,
          "paraphrase 完全零重叠必须为 10/12: %d"
          % r["paraphrase_zero_overlap_count"])
    check(r["zero_overlap_expected_case_count"] == 11,
          "全语料「正确 ID 全部零重叠」必须为 11/111: %d"
          % r["zero_overlap_expected_case_count"])
    by_id = {row["case_id"]: row for row in r["rows"]}
    pp11 = by_id["pp-011"]["expected"][0]
    check(pp11["token_overlap"] == 4 and pp11["rank"] == 1
          and pp11["in_top5"],
          "pp-011 应为共享 4 token、rank 1: %r" % pp11)
    pp04 = by_id["pp-004"]["expected"][0]
    check(pp04["token_overlap"] == 1 and not pp04["in_top5"],
          "pp-004 应共享 1 token 且不进 top5: %r" % pp04)


def test_gated_correct_ids_frozen():
    r = probe_report()
    pairs = {(g["case_id"], g["id"]) for g in r["gated_correct_ids"]}
    want = {(c, i) for c, i in bm25_probe.GATED_CORRECT_IDS}
    check(pairs == want, "6 个被 MIV-005A 过滤的正确 ID 必须逐项记录")
    by = {(g["case_id"], g["id"]): g for g in r["gated_correct_ids"]}
    zero_score = [("ps-007", "mem_fx0c0001"), ("ps-007", "mem_fx0c0002"),
                  ("ps-016", "mem_fx0c0015"), ("cs-012", "mem_fx0f0011")]
    for key in zero_score:
        g = by[key]
        check(g["bm25_score"] == 0.0 and g["token_overlap"] == 0,
              "%s 零重叠必须 score=0: %r" % (key, g))
    g1 = by[("ps-007", "mem_fx0c0003")]
    check(g1["token_overlap"] == 1 and g1["rank"] == 1
          and g1["bm25_score"] > 0.0,
          "ps-007/mem_fx0c0003 应共享 1 token、rank 1: %r" % g1)
    g2 = by[("cs-008", "mem_fx0f0011")]
    check(g2["token_overlap"] == 1 and g2["rank"] == 1
          and g2["in_top5"] and g2["bm25_score"] > 0.0,
          "cs-008/mem_fx0f0011 应共享 1 token、rank 1: %r" % g2)


def test_nm_002_006_would_return():
    r = probe_report()
    got = {row["case_id"]: row for row in r["nm_002_006"]}
    check(set(got) == {"nm-002", "nm-006"},
          "nm-002/nm-006 必须逐例记录")
    for cid in ("nm-002", "nm-006"):
        nm = got[cid]["no_memory"]
        check(nm["positive_bm25_candidates"] == 1
              and nm["would_return_nonempty"],
              "%s：纯 BM25 无准入门时会返回对象（NO MEMORY 失效）: %r"
              % (cid, nm))


def test_no_memory_aggregate_frozen():
    r = probe_report()
    sim = r["simulated_metrics"]
    check(sim["no_memory_total"] == 41,
          "NO MEMORY 总例数必须为 41: %d" % sim["no_memory_total"])
    check(sim["no_memory_correct"] == 39,
          "纯 BM25 假设策略 NO MEMORY 必须为 39/41: %d"
          % sim["no_memory_correct"])
    check(sim["no_memory_violations"] == 2,
          "违反数必须为 2: %d" % sim["no_memory_violations"])
    check(sim["leakage_total"] == 0 and sim["forbidden_hits"] == 0,
          "硬过滤下泄漏必须为 0: %r" % sim)


def test_thresholds_not_met_frozen():
    r = probe_report()
    sim = r["simulated_metrics"]
    v2 = sim["metrics_v2"]
    check(v2["precision_at5_v2"] == 0.71,
          "precision_at5_v2 必须冻结为 0.71: %r" % v2["precision_at5_v2"])
    check(v2["critical_memory_recall_v2"] == 0.9342,
          "critical_memory_recall_v2 必须冻结为 0.9342: %r"
          % v2["critical_memory_recall_v2"])
    check(v2["false_recall_rate_v2"] == 0.29,
          "false_recall_rate_v2 必须冻结为 0.29: %r"
          % v2["false_recall_rate_v2"])
    check(not sim["all_thresholds_met"],
          "单一固定词法策略不得满足全部门槛: %r" % sim["thresholds_met"])
    check(sim["thresholds_met"]["precision_at5_v2_ge_0.90"] is False
          and sim["thresholds_met"]["critical_memory_recall_v2_ge_0.95"]
          is False
          and sim["thresholds_met"]["false_recall_rate_v2_le_0.02"]
          is False
          and sim["thresholds_met"]["no_memory_41_41"] is False
          and sim["thresholds_met"]["leakage_zero"] is True,
          "门槛判定必须与实测一致: %r" % sim["thresholds_met"])


def test_no_content_leakage():
    r = probe_report()
    check(r["content_leaks"] == [], "探针输出不得含任何夹具正文: %r"
          % r["content_leaks"])
    blob = json.dumps(r, ensure_ascii=False, sort_keys=True)
    fixtures = runner.load_fixtures()
    for fid, obj in fixtures.items():
        content = obj.get("content")
        if isinstance(content, str) and content:
            check(content not in blob,
                  "夹具正文泄漏进探针输出: %s" % fid)
    for case in corpus_mod.CASES:
        for marker in case.get("secret_markers", []):
            check(marker not in blob, "secret marker 泄漏: %s"
                  % case["case_id"])


def test_probe_no_forbidden_dependencies():
    path = os.path.join(REPO_ROOT, "memory_eval", "bm25_probe.py")
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    for banned in ("import socket", "import urllib", "import requests",
                   "import httpx", "import jieba", "import nltk",
                   "from transformers", "import torch"):
        check(banned not in src,
              "探针源码不得包含禁用依赖: %s" % banned)
    # 探针只读调用既有 tokenizer，不重新定义分词
    check("def tokenize" not in src,
          "探针不得自定义分词器（必须使用现有 tokenizer）")


def test_probe_never_touches_real_memory():
    objs_dir = os.path.join(REPO_ROOT, "memory", "objects")
    before = set(os.listdir(objs_dir))
    probe_report()
    after = set(os.listdir(objs_dir))
    check(before == after, "探针不得触碰真实 memory/objects")


TESTS = [
    test_probe_deterministic_replay,
    test_probe_covers_all_frozen_cases,
    test_paraphrase_zero_overlap_frozen,
    test_gated_correct_ids_frozen,
    test_nm_002_006_would_return,
    test_no_memory_aggregate_frozen,
    test_thresholds_not_met_frozen,
    test_no_content_leakage,
    test_probe_no_forbidden_dependencies,
    test_probe_never_touches_real_memory,
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
