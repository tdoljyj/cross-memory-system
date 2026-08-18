# -*- coding: utf-8 -*-
"""Memory Eval Runner（MIV-001）：固定时钟 + 固定夹具 + 确定性回放。

职责：
- 把 case 声明的合成夹具物化进临时引擎仓库（paths.set_repo 重定向，绝不触碰真实记忆）
- 以 case.now 为固定时钟、explain=True 跑确定性召回（获得 Trace：预算/原因码/回放哈希）
- 计算指标（§MIV-001 指标定义），输出 JSON 结果 + Markdown 摘要
- 失败样本只含 ID 与 reason code，不含秘密
"""

import hashlib
import json
import os
import shutil
import statistics
import sys
import tempfile
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import recall_engine  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine.recall_trace import trace_digest  # noqa: E402

from . import corpus as corpus_mod  # noqa: E402
from . import schema as eval_schema  # noqa: E402

RUNNER_VERSION = "1.0"
ADAPTER_IDS = ["codex-test", "dsh-test"]


def load_fixtures():
    """加载合成夹具（含运行时秘密替换）。"""
    path = os.path.join(REPO_ROOT, "tests", "fixtures", "memory_eval",
                        "fixtures.json")
    with open(path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    fixtures = payload["fixtures"]
    # 运行时注入固定秘密样值（仓库文件不落任何令牌样值）
    out = {}
    for fid, obj in fixtures.items():
        obj = json.loads(json.dumps(obj, ensure_ascii=False))
        if isinstance(obj.get("content"), str):
            obj["content"] = obj["content"].replace(
                "__FAKE_TOKEN__", corpus_mod.FAKE_TOKEN)
        out[fid] = obj
    return out


def materialize(case, fixtures):
    """物化 case 夹具到临时引擎仓库；返回 (repo_path, fixture_objects)。

    安全不变量：save_object 前必须把 engine_paths 重定向到临时仓库，
    并事后校验真实仓库 objects 目录零新增（防夹具泄漏进真实记忆）。
    """
    tmp = tempfile.mkdtemp(prefix="mem-eval-")
    memdir = os.path.join(tmp, "memory")
    os.makedirs(os.path.join(memdir, "objects"), exist_ok=True)
    os.makedirs(os.path.join(memdir, "audit"), exist_ok=True)
    idx = {
        "schema_version": 1,
        "files": ["画像.md"],
        "recall": {"L1": [], "L2": [], "L3": [], "L4": [], "L5": [], "L6": []},
    }
    with open(os.path.join(memdir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False)
    with open(os.path.join(memdir, "画像.md"), "w", encoding="utf-8") as fh:
        fh.write("# 合成夹具\n")
    guards = os.path.join(REPO_ROOT, "guards.json")
    if os.path.isfile(guards):
        shutil.copy(guards, os.path.join(tmp, "guards.json"))

    real_objects_dir = os.path.join(REPO_ROOT, "memory", "objects")
    before = set(os.listdir(real_objects_dir))

    engine_paths.set_repo(tmp)
    try:
        if os.path.abspath(engine_paths.OBJECTS_DIR) == \
                os.path.abspath(real_objects_dir):
            raise RuntimeError("paths 重定向失败：仍指向真实记忆目录")
        objs = []
        for fid in case["fixtures"]:
            obj = fixtures.get(fid)
            if obj is None:
                raise ValueError("case %s 引用未知夹具 %s"
                                 % (case.get("case_id"), fid))
            store.save_object(obj)
            objs.append(obj)
    finally:
        engine_paths.set_repo(REPO_ROOT)

    after = set(os.listdir(real_objects_dir))
    leaked = after - before
    if leaked:
        raise RuntimeError("夹具泄漏进真实记忆目录: %s" % ", ".join(sorted(leaked)))
    return tmp, objs


def _run_recall_once(case, repo):
    engine_paths.set_repo(repo)
    try:
        t0 = time.perf_counter()
        result = recall_engine.recall(
            query=case["query"],
            tier=case.get("tier", "T2"),
            layers=case.get("layers"),
            scope=eval_schema.scope_to_engine(case.get("scope")),
            include_history=case.get("include_history", False),
            categories=case.get("categories"),
            tags=case.get("tags"),
            entities=case.get("entities"),
            limit=case.get("limit", 10),
            valid_at=S.parse_ts(case.get("now")),
            explain=True,
        )
        latency_ms = (time.perf_counter() - t0) * 1000.0
        trace = result.trace or {}
        return {
            "returned_ids": [o["id"] for o in result.objects],
            "trace": trace,
            "tokens": (trace.get("budget") or {}).get("estimated_tokens", 0),
            "latency_ms": round(latency_ms, 3),
            "trace_digest": trace_digest(trace),
            "error": None,
        }
    except Exception as e:  # noqa: BLE001
        return {
            "returned_ids": [],
            "trace": None,
            "tokens": 0,
            "latency_ms": 0.0,
            "trace_digest": None,
            "error": "ENGINE_EXCEPTION: %s" % type(e).__name__,
        }
    finally:
        engine_paths.set_repo(REPO_ROOT)


def run_case(case, fixtures, adapters=ADAPTER_IDS):
    """跑一个 case（各模拟 Adapter 各一次）。"""
    repo, _objs = materialize(case, fixtures)
    try:
        per_adapter = {}
        for aid in adapters:
            per_adapter[aid] = _run_recall_once(case, repo)
        return per_adapter
    finally:
        engine_paths.set_repo(REPO_ROOT)
        shutil.rmtree(repo, ignore_errors=True)


def _pctl(values, p):
    if not values:
        return None
    s = sorted(values)
    idx = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return s[idx]


def _frac(num, den):
    if not den:
        return None
    return round(num / den, 4)


def compute_case_verdict(case, primary, expected, forbidden, no_memory):
    """单 case 判定。返回 verdict dict（全部只含 ID 与 code，不含内容）。"""
    returned = primary["returned_ids"]
    exp = set(expected)
    ret = set(returned)
    forbidden_hits = sorted(ret & set(forbidden))
    missed = sorted(exp - ret)
    no_memory_violated = bool(no_memory) and bool(returned)
    extra = sorted(ret - exp)
    trace = primary.get("trace") or {}
    reason_codes = {}
    for e in trace.get("excluded", []):
        mid = e.get("memory_id")
        if mid in missed or mid in forbidden:
            reason_codes[mid] = e.get("reason_codes") or []
    critical = case.get("critical_assertions") or []
    critical_failures = []
    if "no_scope_leak" in critical and forbidden_hits:
        critical_failures.append("no_scope_leak")
    if "project_only_isolation" in critical and forbidden_hits:
        critical_failures.append("project_only_isolation")
    if "no_superseded_leak" in critical and forbidden_hits:
        critical_failures.append("no_superseded_leak")
    if "no_stale_recall" in critical and (no_memory_violated or extra):
        critical_failures.append("no_stale_recall")
    if "no_fabrication" in critical and (no_memory_violated or extra):
        critical_failures.append("no_fabrication")
    if "explicit_wins" in critical and missed:
        critical_failures.append("explicit_wins")
    if "paraphrase_hit_top5" in critical:
        if not ret or not (exp & set(returned[:5])):
            critical_failures.append("paraphrase_hit_top5")
    return {
        "case_id": case["case_id"],
        "category": case["category"],
        "returned_ids": returned,
        "expected_relevant_ids": list(expected),
        "forbidden_ids": list(forbidden),
        "forbidden_hits": forbidden_hits,
        "missed": missed,
        "extra": extra,
        "no_memory_expected": bool(no_memory),
        "no_memory_violated": no_memory_violated,
        "critical_failures": critical_failures,
        "reason_codes": reason_codes,
        "error": primary.get("error"),
        "tokens": primary.get("tokens", 0),
        "latency_ms": primary.get("latency_ms", 0.0),
        "trace_digest": primary.get("trace_digest"),
    }


def run_all(cases=None, fixtures=None, adapters=ADAPTER_IDS, warmup=True):
    """完整评测。返回 report dict。"""
    cases = cases if cases is not None else corpus_mod.CASES
    fixtures = fixtures if fixtures is not None else load_fixtures()

    if warmup:
        # 预热：避免首个 case 的导入/分配抖动
        if cases:
            repo, _objs = materialize(cases[0], fixtures)
            try:
                engine_paths.set_repo(repo)
                recall_engine.recall(query="预热", tier="T0", explain=True)
            finally:
                engine_paths.set_repo(REPO_ROOT)
                shutil.rmtree(repo, ignore_errors=True)

    verdicts = []
    for case in cases:
        per = run_case(case, fixtures, adapters)
        primary = per[adapters[0]]
        verdict = compute_case_verdict(
            case, primary, case["expected_relevant_ids"],
            case["forbidden_ids"], case["expected_no_memory"])
        # 跨 Adapter 一致性（模拟 Adapter，同一引擎合同）
        ref = primary["returned_ids"]
        consistent = all(
            per[a]["returned_ids"] == ref for a in adapters[1:])
        verdict["cross_agent_consistent"] = consistent
        verdicts.append(verdict)

    metrics = compute_metrics(verdicts)
    replay_rows = [
        {"case_id": v["case_id"],
         "returned_ids": v["returned_ids"],
         "trace_digest": v["trace_digest"]}
        for v in verdicts
    ]
    replay_hash = hashlib.sha256(
        json.dumps(replay_rows, ensure_ascii=False,
                   sort_keys=True).encode("utf-8")).hexdigest()

    # 秘密泄漏扫描（结果 JSON 不得出现任何 case 声明的 marker）
    result_blob = json.dumps(
        {"verdicts": verdicts, "metrics": metrics},
        ensure_ascii=False, sort_keys=True)
    secret_leaks = []
    for case in cases:
        for marker in case.get("secret_markers", []):
            if marker and marker in result_blob:
                secret_leaks.append(case["case_id"])

    report = {
        "runner_version": RUNNER_VERSION,
        "eval_schema_version": eval_schema.SCHEMA_VERSION,
        "corpus_hash": corpus_mod.corpus_hash(),
        "case_count": len(cases),
        "adapter_ids": list(adapters),
        "fixed_now": corpus_mod.DEFAULT_NOW,
        "metrics": metrics,
        "replay_hash": replay_hash,
        "secret_leaks": secret_leaks,
        "verdicts": verdicts,
    }
    return report


def compute_metrics(verdicts):
    """§MIV-001 指标定义。所有分母为 0 的比率记 None（NOT_APPLICABLE）。"""
    # 全局计数
    total_cases = len(verdicts)
    no_memory_cases = [v for v in verdicts if v["no_memory_expected"]]
    no_memory_correct = sum(1 for v in no_memory_cases
                            if not v["no_memory_violated"])
    no_memory_violations = sum(1 for v in verdicts if v["no_memory_violated"])

    returned_all = [v for v in verdicts if v["returned_ids"]]
    total_returned = sum(len(v["returned_ids"]) for v in returned_all)
    false_items = sum(len(v["extra"]) + len(v["forbidden_hits"])
                      for v in returned_all)
    missed_items = sum(len(v["missed"]) for v in verdicts)
    forbidden_hits = sum(len(v["forbidden_hits"]) for v in verdicts)

    # Precision@5（golden 非空的 case）
    prec_cases = [v for v in verdicts
                  if v["expected_relevant_ids"] and v["returned_ids"]]
    if prec_cases:
        precs = []
        for v in prec_cases:
            top5 = set(v["returned_ids"][:5])
            hit = len(top5 & set(v["expected_relevant_ids"]))
            precs.append(hit / 5.0)
        precision_at5 = round(statistics.mean(precs), 4)
    else:
        precision_at5 = None

    # critical-memory recall（golden 非空的 case）
    crit_hit = sum(len(set(v["expected_relevant_ids"]) &
                       set(v["returned_ids"]))
                   for v in verdicts if v["expected_relevant_ids"])
    crit_total = sum(len(set(v["expected_relevant_ids"]))
                     for v in verdicts if v["expected_relevant_ids"])
    critical_recall = _frac(crit_hit, crit_total)

    # false recall rate（条目级）
    false_recall_rate = _frac(false_items, total_returned)
    # stale recall：temporal 类 case 中 extra/违反 no_memory 的条目
    temporal_cases = [v for v in verdicts if v["category"] == "temporal"]
    stale_items = sum(len(v["extra"]) for v in temporal_cases) + \
        sum(1 for v in temporal_cases if v["no_memory_violated"])
    stale_total = sum(len(v["returned_ids"]) for v in temporal_cases) + \
        len(temporal_cases)
    stale_recall_rate = _frac(stale_items, stale_total)

    # scope 拆分：既有 current-scope 边界泄漏（须为 0）vs project_id 隔离能力缺口（MIV-006）
    current_scope_leakage = sum(len(v["forbidden_hits"]) for v in verdicts
                                if _has_assert(v, "no_scope_leak"))
    project_only_gap = sum(len(v["forbidden_hits"]) for v in verdicts
                           if _has_assert(v, "project_only_isolation"))
    superseded_leakage = sum(len(v["forbidden_hits"]) for v in verdicts
                             if _has_superseded_critical(v))

    # NO MEMORY correctness
    no_memory_correctness = _frac(no_memory_correct, len(no_memory_cases))

    # cross-agent consistency
    consist = sum(1 for v in verdicts if v["cross_agent_consistent"])
    cross_agent_consistency = _frac(consist, total_cases)

    # token / latency P50/P95（非空召回）
    tokens = [v["tokens"] for v in returned_all if v["tokens"] is not None]
    lats = [v["latency_ms"] for v in verdicts if v["latency_ms"]]
    per_cat = {}
    for cat in eval_schema.CATEGORIES:
        cat_v = [v for v in verdicts if v["category"] == cat]
        if not cat_v:
            continue
        cat_prec_cases = [v for v in cat_v
                          if v["expected_relevant_ids"] and v["returned_ids"]]
        if cat_prec_cases:
            cat_prec = statistics.mean(
                len(set(v["returned_ids"][:5]) &
                    set(v["expected_relevant_ids"])) / 5.0
                for v in cat_prec_cases)
        else:
            cat_prec = None
        per_cat[cat] = {
            "cases": len(cat_v),
            "precision_at5": round(cat_prec, 4) if cat_prec is not None
            else None,
            "forbidden_hits": sum(len(v["forbidden_hits"]) for v in cat_v),
            "critical_failures": sum(1 for v in cat_v if v["critical_failures"]),
        }

    return {
        "case_count": total_cases,
        "precision_at5": precision_at5,
        "critical_memory_recall": critical_recall,
        "false_recall_rate": false_recall_rate,
        "stale_recall_rate": stale_recall_rate,
        "current_scope_leakage_count": current_scope_leakage,
        "project_only_capability_gap_count": project_only_gap,
        "superseded_leakage_count": superseded_leakage,
        "no_memory_correctness": no_memory_correctness,
        "no_memory_violations": no_memory_violations,
        "cross_agent_consistency": cross_agent_consistency,
        "estimated_prompt_tokens_p50": _pctl(tokens, 50),
        "estimated_prompt_tokens_p95": _pctl(tokens, 95),
        "recall_latency_ms_p50": round(_pctl(lats, 50), 3)
        if lats else None,
        "recall_latency_ms_p95": round(_pctl(lats, 95), 3)
        if lats else None,
        "missed_items": missed_items,
        "forbidden_hits": forbidden_hits,
        "per_category": per_cat,
    }


def _has_assert(v, name):
    """critical_failures 中命中指定断言 = 该断言对应的 forbidden 越权/差距。"""
    fails = v.get("critical_failures") or []
    return bool(v.get("forbidden_hits")) and name in fails


def _has_superseded_critical(v):
    """superseded 类 critical 断言的 forbidden 命中 = superseded leakage。"""
    return _has_assert(v, "no_superseded_leak")


def render_markdown(report):
    """人类可读 Markdown 摘要 + 失败样本（无秘密）。"""
    m = report["metrics"]
    lines = []
    lines.append("# Memory Eval Baseline Report")
    lines.append("")
    lines.append("- runner: %s" % report["runner_version"])
    lines.append("- eval schema: v%d" % report["eval_schema_version"])
    lines.append("- corpus hash: `%s`" % report["corpus_hash"])
    lines.append("- cases: %d" % report["case_count"])
    lines.append("- adapters: %s" % ", ".join(report["adapter_ids"]))
    lines.append("- fixed clock: %s" % report["fixed_now"])
    lines.append("")
    lines.append("## 指标")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("| --- | --- |")
    for key in ("precision_at5", "critical_memory_recall",
                "false_recall_rate", "stale_recall_rate",
                "current_scope_leakage_count",
                "project_only_capability_gap_count",
                "superseded_leakage_count",
                "no_memory_correctness", "no_memory_violations",
                "cross_agent_consistency",
                "estimated_prompt_tokens_p50",
                "estimated_prompt_tokens_p95",
                "recall_latency_ms_p50", "recall_latency_ms_p95"):
        v = m.get(key)
        lines.append("| %s | %s |" % (key, v if v is not None else "NOT_APPLICABLE"))
    lines.append("")
    lines.append("## 分类指标")
    lines.append("")
    lines.append("| 类别 | 用例数 | Precision@5 | 越权命中 | 关键断言失败 |")
    lines.append("| --- | ---: | ---: | ---: | ---: |")
    for cat, d in m.get("per_category", {}).items():
        lines.append("| %s | %d | %s | %d | %d |" % (
            cat, d["cases"],
            d["precision_at5"] if d["precision_at5"] is not None else "N/A",
            d["forbidden_hits"], d["critical_failures"]))
    lines.append("")
    fails = [v for v in report["verdicts"]
             if v["critical_failures"] or v["no_memory_violated"]
             or v["forbidden_hits"] or v["missed"]]
    lines.append("## 失败/差距样本（%d 例）" % len(fails))
    lines.append("")
    if not fails:
        lines.append("（无）")
    for v in fails[:30]:
        lines.append("- `%s` [%s]" % (v["case_id"], v["category"]))
        if v["missed"]:
            lines.append("  - missed: %s" % ", ".join(v["missed"]))
        if v["extra"]:
            lines.append("  - extra: %s" % ", ".join(v["extra"]))
        if v["forbidden_hits"]:
            lines.append("  - forbidden hits: %s" % ", ".join(v["forbidden_hits"]))
        if v["no_memory_violated"]:
            lines.append("  - no-memory violated: returned %s"
                         % ", ".join(v["returned_ids"][:5]))
        if v["critical_failures"]:
            lines.append("  - critical: %s" % ", ".join(v["critical_failures"]))
        if v["reason_codes"]:
            rc = "; ".join("%s=%s" % (k, ",".join(c))
                           for k, c in list(v["reason_codes"].items())[:3])
            lines.append("  - reason codes: %s" % rc)
        if v["error"]:
            lines.append("  - error: %s" % v["error"])
    if len(fails) > 30:
        lines.append("（其余 %d 例见 results.json）" % (len(fails) - 30))
    lines.append("")
    lines.append("## 回放与秘密")
    lines.append("")
    lines.append("- replay hash: `%s`" % report["replay_hash"])
    lines.append("- secret leaks: %s" % (report["secret_leaks"] or "0"))
    lines.append("")
    return "\n".join(lines)
