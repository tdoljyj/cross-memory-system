# -*- coding: utf-8 -*-
"""MIV-005B 词法可行性探针（BM25，确定性，纯离线评测；不接入 memory_engine）。

目标：在 **不改动 memory_engine/** 与生产召回** 的前提下，度量「单一固定
词法策略」对 111 个冻结 Eval Case 的能力上限，回答「纯 BM25 能否同时满足
Gate 2R 指标门槛（precision_at5_v2 ≥ 0.90 / critical_memory_recall_v2
≥ 0.95 / false_recall_rate_v2 ≤ 0.02 / NO MEMORY 41/41 / 泄漏全 0）」。

固定策略（裁决授权边界内，无任何可调余地）：
    - tokenizer = `memory_engine.conflict.tokenize`（现有冻结 tokenizer，
      CJK 字符 bigram + 拉丁/数字词，返回集合）
    - BM25：k1 = 1.2，b = 0.75
    - tf = 集合存在性（tokenizer 返回集合 → 出现即 1，不做频率重数）
    - doclen = 对象 token 集合大小；avgdl = 全部 94 个冻结合成夹具的均值
    - IDF 语料 = 全部 94 个冻结合成夹具（tests/fixtures/memory_eval/
      fixtures.json，与 case 无关、固定）
    - score(D,Q) = Σ_{t∈Q∩D} idf(t) · (k1+1) / (1 + k1·(1-b+b·|D|/avgdl))
    - idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
    禁止：synonym map、query 特判、embedding、模型下载、网络访问、
    第三方分词库。

管道镜像（只读调用既有引擎函数，生产代码零改动）：
    状态过滤 → scope/category 过滤 → temporal → tags/entities → light
    → conflict（非历史查询）→ BM25 排名（替代 _match_score 与 >1/6
    准入门）→ Top-limit
    即与生产管线唯一差异 = 打分函数换成纯 BM25 且没有相关性准入门；
    hard filters、conflict→limit 顺序语义、排序 tie-break
    （priority/evidence/updated_at，末位加 id 保证确定性）全部沿用。

输出纪律：**只输出 ID 与数值，零记忆正文泄漏**（无 content/query 原文；
case_id / object id / token 数 / overlap 数 / score / rank / top5 / 计数）。
"""
import hashlib
import json
import math
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine import conflict  # noqa: E402  (现有冻结 tokenizer)
from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import recall_engine as RE  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine import temporal as T  # noqa: E402

from . import corpus as corpus_mod  # noqa: E402
from . import metrics as metrics_v2  # noqa: E402
from . import runner  # noqa: E402
from . import schema as eval_schema  # noqa: E402

PROBE_VERSION = "1.0"
K1 = 1.2
B = 0.75

# MIV-005A 报告 §4.2 冻结清单：被 >1/6 准入门过滤的 6 个正确 ID
# （ps-007×3、ps-016×1、cs-008×1、cs-012×1）
GATED_CORRECT_IDS = [
    ("ps-007", "mem_fx0c0001"),
    ("ps-007", "mem_fx0c0002"),
    ("ps-007", "mem_fx0c0003"),
    ("ps-016", "mem_fx0c0015"),
    ("cs-008", "mem_fx0f0011"),
    ("cs-012", "mem_fx0f0011"),
]


class BM25Index:
    """固定 BM25 索引：IDF 语料 = 全部 94 个冻结合成夹具。"""

    def __init__(self, fixtures):
        self.k1 = K1
        self.b = B
        self.docs = {}
        self.df = {}
        for fid, obj in fixtures.items():
            content = obj.get("content")
            if not isinstance(content, str):
                continue
            toks = conflict.tokenize(content)
            self.docs[fid] = toks
            for t in toks:
                self.df[t] = self.df.get(t, 0) + 1
        self.N = len(self.docs)
        self.avgdl = (sum(len(t) for t in self.docs.values())
                      / float(self.N)) if self.N else 0.0

    def idf(self, token):
        df = self.df.get(token, 0)
        return math.log(1.0 + (self.N - df + 0.5) / (df + 0.5))

    def score(self, query, fixture_id):
        doc = self.docs.get(fixture_id)
        if not doc:
            return 0.0
        q_tokens = conflict.tokenize(query)
        if not q_tokens:
            return 0.0
        dl = float(len(doc))
        norm = 1.0 + self.k1 * (1.0 - self.b + self.b * dl / self.avgdl)
        total = 0.0
        for t in q_tokens:
            if t in doc:
                total += self.idf(t) * (self.k1 + 1.0) / norm
        return total

    def overlap(self, query, fixture_id):
        doc = self.docs.get(fixture_id)
        if not doc:
            return 0
        return len(conflict.tokenize(query) & doc)


def _hard_filter(case, objects, engine_scope, project_id, valid_at):
    """镜像 recall() 的打分前硬过滤（状态/scope-category/temporal/
    selector/light），只读调用既有判定函数，顺序与生产一致。"""
    tier = (case.get("tier") or "T2").upper()
    layers = list(case.get("layers") or [])
    if not layers:
        layers = list(S.TIER_LAYERS.get(tier, []))
    layers = [l for l in layers if l in S.RECALL_LAYERS]
    light = (tier == "T3")
    want_categories = list(case.get("categories") or [])
    if not want_categories:
        for l in layers:
            want_categories.extend(S.LAYER_CATEGORIES.get(l, []))
    statuses = set(S.RECALLABLE_STATUSES)
    if case.get("include_history"):
        statuses |= set(S.HISTORY_STATUSES)
    counts = {"status": 0, "scope_category": 0, "temporal": 0,
              "selector": 0, "light": 0}
    kept = []
    for obj in objects:
        if obj.get("status") not in statuses:
            counts["status"] += 1
            continue
        if not RE._category_scope_ok(obj, want_categories, engine_scope,
                                     project_id, None):
            counts["scope_category"] += 1
            continue
        expired_now = T.is_expired(obj, valid_at)
        is_history = case.get("include_history") and (
            obj.get("status") in S.HISTORY_STATUSES or expired_now)
        if not is_history and not T.is_valid_now(obj, valid_at):
            counts["temporal"] += 1
            continue
        tags = case.get("tags")
        entities = case.get("entities")
        if tags and not (set(tags) & set(obj.get("tags") or [])):
            counts["selector"] += 1
            continue
        if entities and not (set(entities) & set(obj.get("entities") or [])):
            counts["selector"] += 1
            continue
        if light and (obj.get("classification") or {}).get("priority") != "high":
            counts["light"] += 1
            continue
        kept.append(obj)
    return kept, counts, light


def _run_case(case, repo, bm25):
    engine_paths.set_repo(repo)
    try:
        tier = (case.get("tier") or "T2").upper()
        if tier == "T0":
            # 生产语义：T0 在打分前零读取短路（非评分策略，假设策略保持）
            row = {
                "case_id": case["case_id"],
                "category": case["category"],
                "query_tokens": len(conflict.tokenize(case["query"])),
                "candidate_ids": [],
                "top5_ids": [],
                "conflict_losers": [],
                "filter_counts": {"status": 0, "scope_category": 0,
                                  "temporal": 0, "selector": 0, "light": 0},
                "expected": [],
                "zero_overlap": None,
                "no_memory": ({"positive_bm25_candidates": 0,
                               "would_return_nonempty": False}
                              if case["expected_no_memory"] else None),
            }
            return row, []
        objects = store.load_all_objects()
        engine_scope, project_id = eval_schema.scope_to_engine(
            case.get("scope"))
        valid_at = S.parse_ts(case.get("now"))
        kept, counts, light = _hard_filter(
            case, objects, engine_scope, project_id, valid_at)
        if case.get("include_history"):
            survivors, losers = kept, set()
        else:
            survivors, losers = RE._conflict_filter(kept)
        scored = [(o, bm25.score(case["query"], o["id"])) for o in survivors]
        # 排序：BM25 降序；tie-break 沿用生产 _rank_key + 末位 id（确定性）
        ranked = sorted(scored, key=lambda p: RE._rank_key(p[0], p[1])
                        + (p[0]["id"],), reverse=True)
        limit = int(case.get("limit", 10))
        if light:
            limit = min(limit, 3)
        top_ids = [o["id"] for o, _s in ranked[:limit]]

        query_tokens = len(conflict.tokenize(case["query"]))
        expected_rows = []
        for eid in case["expected_relevant_ids"]:
            s = bm25.score(case["query"], eid)
            ov = bm25.overlap(case["query"], eid)
            rank = None
            for i, (o, _s) in enumerate(ranked, 1):
                if o["id"] == eid:
                    rank = i
                    break
            expected_rows.append({
                "id": eid,
                "token_overlap": ov,
                "bm25_score": round(s, 4),
                "rank": rank,
                "in_top5": eid in top_ids[:5],
            })
        row = {
            "case_id": case["case_id"],
            "category": case["category"],
            "query_tokens": query_tokens,
            "candidate_ids": [o["id"] for o, _s in ranked],
            "top5_ids": top_ids[:5],
            "conflict_losers": sorted(losers),
            "filter_counts": counts,
            "expected": expected_rows,
            "zero_overlap": (all(e["token_overlap"] == 0 for e in expected_rows)
                             if expected_rows else None),
        }
        if case["expected_no_memory"]:
            positive = sum(1 for _o, s in scored if s > 0.0)
            row["no_memory"] = {
                "positive_bm25_candidates": positive,
                "would_return_nonempty": bool(top_ids),
            }
        else:
            row["no_memory"] = None
        return row, top_ids
    finally:
        engine_paths.set_repo(REPO_ROOT)


def run_probe(cases=None, fixtures=None, warmup=True):
    """对全部 case 跑纯 BM25 假设策略，返回确定性 report（仅 ID 与数值）。"""
    cases = cases if cases is not None else corpus_mod.CASES
    fixtures = fixtures if fixtures is not None else runner.load_fixtures()
    bm25 = BM25Index(fixtures)

    if warmup and cases:
        repo, _objs = runner.materialize(cases[0], fixtures)
        try:
            _run_case(cases[0], repo, bm25)
        finally:
            shutil.rmtree(repo, ignore_errors=True)

    run_root = tempfile.mkdtemp(prefix="bm25-probe-")
    rows = []
    verdicts = []
    try:
        for case in cases:
            repo, _objs = runner.materialize(case, fixtures,
                                             base_dir=run_root)
            row, top_ids = _run_case(case, repo, bm25)
            rows.append(row)
            pseudo_primary = {
                "returned_ids": top_ids,
                "trace": {},
                "tokens": 0,
                "latency_ms": 0.0,
                "trace_digest": None,
                "error": None,
            }
            verdict = runner.compute_case_verdict(
                case, pseudo_primary, case["expected_relevant_ids"],
                case["forbidden_ids"], case["expected_no_memory"])
            verdict["cross_agent_consistent"] = True
            verdicts.append(verdict)
    finally:
        engine_paths.set_repo(REPO_ROOT)
        shutil.rmtree(run_root, ignore_errors=True)

    # ---- 模拟策略指标（复用既有判定与 v2 指标公式，零新公式）----
    v2 = metrics_v2.compute_v2(verdicts)
    v1 = runner.compute_metrics(verdicts)
    nm_total = sum(1 for v in verdicts if v["no_memory_expected"])
    nm_ok = sum(1 for v in verdicts if v["no_memory_expected"]
                and not v["no_memory_violated"])
    leakage = (v1["current_scope_leakage_count"]
               + v1["project_only_capability_gap_count"]
               + v1["superseded_leakage_count"])
    sim = {
        "metrics_v2": v2,
        "no_memory_total": nm_total,
        "no_memory_correct": nm_ok,
        "no_memory_violations": v1["no_memory_violations"],
        "forbidden_hits": v1["forbidden_hits"],
        "leakage_total": leakage,
        "stale_recall_rate": v1["stale_recall_rate"],
    }
    sim["thresholds_met"] = {
        "precision_at5_v2_ge_0.90": (v2["precision_at5_v2"] or 0.0) >= 0.90,
        "critical_memory_recall_v2_ge_0.95":
            (v2["critical_memory_recall_v2"] or 0.0) >= 0.95,
        "false_recall_rate_v2_le_0.02":
            (v2["false_recall_rate_v2"] or 1.0) <= 0.02,
        "no_memory_41_41": nm_total == nm_ok,
        "leakage_zero": leakage == 0,
    }
    sim["all_thresholds_met"] = all(sim["thresholds_met"].values())

    # ---- 专项切片 ----
    by_id = {r["case_id"]: r for r in rows}
    paraphrase = [r for r in rows if r["category"] == "paraphrase"]
    gated = []
    for case_id, oid in GATED_CORRECT_IDS:
        entry = None
        for e in by_id.get(case_id, {}).get("expected", []):
            if e["id"] == oid:
                entry = e
                break
        gated.append({
            "case_id": case_id,
            "id": oid,
            "token_overlap": entry["token_overlap"] if entry else None,
            "bm25_score": entry["bm25_score"] if entry else None,
            "rank": entry["rank"] if entry else None,
            "in_top5": entry["in_top5"] if entry else None,
        })
    nm_002_006 = [r for r in rows if r["case_id"] in ("nm-002", "nm-006")]
    no_memory_rows = [r for r in rows if r["no_memory"] is not None]
    zero_overlap_expected = sum(
        1 for r in rows
        if r["expected"] and all(e["token_overlap"] == 0 for e in r["expected"]))
    zero_overlap_paraphrase = sum(
        1 for r in paraphrase
        if r["expected"] and all(e["token_overlap"] == 0 for e in r["expected"]))

    # ---- 确定性重放 hash（仅 ID 与数值，key 排序 + 稳定序列化）----
    canon_rows = [dict(sorted(r.items())) for r in rows]
    canon_rows.sort(key=lambda r: r["case_id"])
    replay_hash = hashlib.sha256(
        json.dumps(canon_rows, ensure_ascii=False,
                   sort_keys=True).encode("utf-8")).hexdigest()
    fixtures_blob = json.dumps(
        {k: fixtures[k] for k in sorted(fixtures)},
        ensure_ascii=False, sort_keys=True)
    fixtures_hash = hashlib.sha256(
        fixtures_blob.encode("utf-8")).hexdigest()

    # ---- 秘密/正文泄漏检查（探针输出不得出现任何 fixture 正文或 marker）----
    blob = json.dumps({
        "rows": rows, "paraphrase": paraphrase, "gated": gated,
        "nm_002_006": nm_002_006, "no_memory_rows": no_memory_rows,
        "sim": sim,
    }, ensure_ascii=False, sort_keys=True)
    leaks = []
    for fid, obj in fixtures.items():
        content = obj.get("content")
        if isinstance(content, str) and content and content in blob:
            leaks.append(fid)
    for case in cases:
        for marker in case.get("secret_markers", []):
            if marker and marker in blob:
                leaks.append(case["case_id"] + ":marker")

    return {
        "probe_version": PROBE_VERSION,
        "bm25_params": {
            "k1": K1,
            "b": B,
            "tokenizer": "memory_engine.conflict.tokenize",
            "tf": "set_presence",
            "collection": "all 94 frozen fixtures",
            "forbidden": ["synonym_map", "query_special_case", "embedding",
                          "model_download", "network", "third_party_tokenizer"],
        },
        "corpus_hash": corpus_mod.corpus_hash(),
        "fixtures_hash": fixtures_hash,
        "case_count": len(rows),
        "rows": rows,
        "paraphrase_cases": paraphrase,
        "paraphrase_zero_overlap_count": zero_overlap_paraphrase,
        "zero_overlap_expected_case_count": zero_overlap_expected,
        "gated_correct_ids": gated,
        "nm_002_006": nm_002_006,
        "no_memory_rows": no_memory_rows,
        "simulated_metrics": sim,
        "replay_hash": replay_hash,
        "content_leaks": leaks,
    }


def render_markdown(report):
    """人类可读摘要（同样只含 ID 与数值）。"""
    sim = report["simulated_metrics"]
    v2 = sim["metrics_v2"]
    lines = ["# MIV-005B 词法可行性探针报告（纯 BM25 假设策略）", ""]
    lines.append("- probe: %s（k1=%s, b=%s）" % (
        report["probe_version"], report["bm25_params"]["k1"],
        report["bm25_params"]["b"]))
    lines.append("- corpus hash: `%s`" % report["corpus_hash"])
    lines.append("- fixtures hash: `%s…`" % report["fixtures_hash"][:16])
    lines.append("- cases: %d（paraphrase 零重叠 %d / 12）" % (
        report["case_count"], report["paraphrase_zero_overlap_count"]))
    lines.append("- replay hash: `%s`" % report["replay_hash"])
    lines.append("")
    lines.append("## 假设策略指标（无准入门、纯 BM25 排名）")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("| --- | --- |")
    for key, label in (
            ("precision_at5_v2", "precision_at5_v2（门槛 ≥0.90）"),
            ("critical_memory_recall_v2", "critical_memory_recall_v2（门槛 ≥0.95）"),
            ("false_recall_rate_v2", "false_recall_rate_v2（门槛 ≤0.02）"),
            ("hit_rate_at5", "hit_rate_at5")):
        lines.append("| %s | %s |" % (label, v2.get(key)))
    lines.append("| NO MEMORY | %d/%d |" % (
        sim["no_memory_correct"], sim["no_memory_total"]))
    lines.append("| 泄漏（scope/project/superseded） | %d |" % (
        sim["leakage_total"]))
    lines.append("| 全部门槛达成 | %s |" % sim["all_thresholds_met"])
    lines.append("")
    lines.append("## 12 个 paraphrase case（token overlap / BM25）")
    lines.append("")
    lines.append("| case | 查询 token 数 | 零重叠 | 正确 ID | overlap | bm25 | rank | top5 |")
    lines.append("| --- | ---: | --- | --- | ---: | ---: | ---: | --- |")
    for r in sorted(report["paraphrase_cases"], key=lambda x: x["case_id"]):
        for e in r["expected"]:
            lines.append("| %s | %d | %s | %s | %d | %s | %s | %s |" % (
                r["case_id"], r["query_tokens"], r["zero_overlap"],
                e["id"], e["token_overlap"], e["bm25_score"],
                e["rank"] if e["rank"] is not None else "-",
                "Y" if e["in_top5"] else "N"))
    lines.append("")
    lines.append("## 被 MIV-005A 过滤的 6 个正确 ID（纯 BM25 下的处境）")
    lines.append("")
    lines.append("| case | id | overlap | bm25 | rank | top5 |")
    lines.append("| --- | --- | ---: | ---: | ---: | --- |")
    for g in report["gated_correct_ids"]:
        lines.append("| %s | %s | %s | %s | %s | %s |" % (
            g["case_id"], g["id"], g["token_overlap"], g["bm25_score"],
            g["rank"] if g["rank"] is not None else "-",
            "Y" if g["in_top5"] else "N"))
    lines.append("")
    lines.append("## nm-002 / nm-006")
    lines.append("")
    for r in report["nm_002_006"]:
        nm = r["no_memory"] or {}
        lines.append("- %s：positive_bm25=%s would_return=%s top5=%s" % (
            r["case_id"], nm.get("positive_bm25_candidates"),
            nm.get("would_return_nonempty"), ",".join(r["top5_ids"])))
    lines.append("")
    lines.append("## 结论")
    lines.append("")
    lines.append("单一固定词法策略（现有 tokenizer + BM25 k1=1.2/b=0.75）"
                 "**不满足** Gate 2R 指标门槛（见上表）；词法上限如实记录，"
                 "不修改生产召回。")
    return "\n".join(lines)


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(prog="bm25_probe",
                                 description="MIV-005B BM25 可行性探针")
    ap.add_argument("--out", default=os.path.join(
        REPO_ROOT, "..", "gate2r-miv005b-audit"),
        help="输出目录（默认仓库外 ../gate2r-miv005b-audit）")
    args = ap.parse_args(argv)
    report = run_probe()
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, "probe_results.json"), "w",
              encoding="utf-8", newline="\n") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    with open(os.path.join(args.out, "probe_report.md"), "w",
              encoding="utf-8", newline="\n") as fh:
        fh.write(render_markdown(report))
    print("results: %s" % os.path.join(args.out, "probe_results.json"))
    print("cases: %d  replay: %s  leaks: %s" % (
        report["case_count"], report["replay_hash"][:16],
        report["content_leaks"] or "0"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
