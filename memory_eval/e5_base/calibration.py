# -*- coding: utf-8 -*-
"""E5-base sealed calibration runner（R4 Gate 0 E5-base 实施轮）。

被测路径：memory_engine.recall(..., semantic_mode="test", vector_runtime=...)
参数网格：e5-base-candidate-lock.json 冻结的 35 组合
  （tau {0.60..0.90}×7 × alpha {0.0..1.0}×5）
canonical oracle：memory_eval/e5_base/oracle_v3.py（独立实现，
  消费 frozen-hard-filter-contract.json + 冻结夹具元数据）

硬失败语义（产品所有者裁决 2026-08-21）：
- 任何锁 digest / Runtime Trace / canonical Trace 不一致 → 整轮 FAIL
- CONFLICT_LOSER 不得被向量路径复活（显式检查 + FORBIDDEN_LEAKAGE）
- 35 组合 0 qualifying → 本合同下 E5-base NO-GO（不扩网格、不重试）

不读取 holdout 任何内容（calibration bundle 之外的输入零解析）。
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_eval import gate0_calibration as G0  # noqa: E402
from memory_eval import metrics as metrics_v2  # noqa: E402
from memory_eval.e5_base import oracle_v3 as OV  # noqa: E402

CANDIDATE_LOCK_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "locks", "e5-base-candidate-lock.json")
CONTRACT_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "locks", "frozen-hard-filter-contract.json")
ORACLE_SPEC_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "locks", "oracle-v3-spec.md")
HOLDOUT_MANIFEST_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "evidence", "frozen-eval-manifest.json")
REQUIREMENTS_LOCK_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "evidence", "requirements-gate0b.lock.txt")

CALIBRATION_SCHEMA_VERSION = "r4-gate0-e5base-calibration-v1"

# 网格冻结期望（与候选锁双校验；锁被改动即 FAIL）
EXPECTED_TAU_GRID = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]
EXPECTED_ALPHA_GRID = [0.0, 0.25, 0.5, 0.75, 1.0]
EXPECTED_GRID_COUNT = 35

# 质量硬门槛逐字沿用 E5-small 轮（ADR-MIV-005B-002 §4 的 calibration 子集）
HARD_GATE_REFERENCE = (
    "precision_at5_v2>=0.90; critical_memory_recall_v2>=0.95; "
    "false_recall_rate_v2<=0.02; no_memory all correct; forbidden_hits==0; "
    "error_count==0; lexical_expected_preservation==1.0; "
    "prompt_token_p95<=650")


class E5BaseCalibrationError(RuntimeError):
    pass


def _sha_file(path):
    return G0._sha_file(path)


def _canonical_digest(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def verify_lock_digests():
    """候选锁自身 + 锁内钉定的全部 digest 逐项实测校验。"""
    with open(CANDIDATE_LOCK_PATH, "r", encoding="utf-8") as fh:
        lock = json.load(fh)
    if lock.get("lock_type") != "e5-base-eval-candidate-lock":
        raise E5BaseCalibrationError("CANDIDATE_LOCK_TYPE_MISMATCH")
    if lock.get("lock_version") != 2:
        raise E5BaseCalibrationError("CANDIDATE_LOCK_VERSION_MISMATCH")
    model = lock.get("model") or {}
    if model.get("id") != "intfloat/multilingual-e5-base":
        raise E5BaseCalibrationError("MODEL_ID_MISMATCH")
    if model.get("trust_remote_code") is not False:
        raise E5BaseCalibrationError("TRUST_REMOTE_CODE_NOT_FALSE")

    grid = lock.get("grid") or {}
    if grid.get("tau") != EXPECTED_TAU_GRID or \
            grid.get("alpha") != EXPECTED_ALPHA_GRID or \
            grid.get("combination_count") != EXPECTED_GRID_COUNT:
        raise E5BaseCalibrationError("GRID_MISMATCH_VS_FROZEN_EXPECTATION")

    measured = {
        "oracle_v3_spec": _sha_file(ORACLE_SPEC_PATH),
        "frozen_hard_filter_contract": _sha_file(CONTRACT_PATH),
        "holdout_manifest": _sha_file(HOLDOUT_MANIFEST_PATH),
        "requirements_lock": _sha_file(REQUIREMENTS_LOCK_PATH),
    }
    expected = {
        "oracle_v3_spec": (lock.get("oracle_v3") or {}).get("spec_sha256"),
        "frozen_hard_filter_contract": (
            (lock.get("oracle_v3") or {}).get(
                "frozen_hard_filter_contract") or {}).get("sha256"),
        "holdout_manifest": (lock.get("holdout_manifest") or {}).get("sha256"),
        "requirements_lock": (lock.get("backend") or {}).get(
            "requirements_lock_sha256"),
    }
    for key in sorted(expected):
        if measured[key] != expected[key]:
            raise E5BaseCalibrationError(
                "LOCK_DIGEST_MISMATCH:%s measured=%s expected=%s"
                % (key, measured[key], expected[key]))
    return lock, measured


def run_calibration(model_dir, output_json, output_markdown,
                    index_dir=None, label="main"):
    """一次完整 calibration 运行（主运行 / 复验共用同一入口）。"""
    import torch  # backend 环境证明（torch 版本由 embedder 校验）
    from memory_eval.e5_base.embedder import (
        E5BaseEmbedder, build_manifest, verify_backend_versions,
        MANIFEST_FILENAME)

    lock, lock_digests = verify_lock_digests()

    # ---- 输入 bundle 完整性（复用 E5-small 轮的 sealed 校验）----
    calib_lock, cases, fixture_bundle = G0.verify_and_load_inputs()
    fixtures, synthetic_secret = G0._runtime_fixture_copy(fixture_bundle)

    # ---- canonical oracle v3（独立实现，先于任何运行）----
    oracle = OV.CanonicalOracleV3(
        CONTRACT_PATH, expected_sha256=lock_digests[
            "frozen_hard_filter_contract"])
    oracle_results = oracle.judge_all(cases, fixtures)
    oracle_digest = _canonical_digest(oracle_results)

    # ---- 派生索引（仓库外、可删除、可完整重建；768 维 float32）----
    if index_dir is not None:
        index_root = os.path.abspath(index_dir)
        repo_abs = os.path.abspath(REPO_ROOT)
        if os.path.commonpath([index_root, repo_abs]) in (
                index_root, repo_abs):
            raise E5BaseCalibrationError("INDEX_DIR_INSIDE_REPOSITORY")

    verify_backend_versions()
    if not os.path.isfile(os.path.join(model_dir, MANIFEST_FILENAME)):
        manifest = build_manifest(
            model_dir, "%d.%d.%d" % sys.version_info[:3])
        with open(os.path.join(model_dir, MANIFEST_FILENAME), "w",
                  encoding="utf-8", newline="\n") as fh:
            json.dump(manifest, fh, ensure_ascii=False, sort_keys=True,
                      indent=2)
            fh.write("\n")
    embedder = E5BaseEmbedder(model_dir, device="cpu")

    # ---- 向量运行时（内存表 + 仓库外落盘快照）----
    runtime = G0.CalibrationVectorRuntime(embedder, cases, fixtures)
    index_evidence = None
    if index_dir is not None:
        os.makedirs(index_dir, exist_ok=True)
        vectors_path = os.path.join(index_dir, "vectors.f32")
        ids_path = os.path.join(index_dir, "object_ids.json")
        import struct
        with open(vectors_path, "wb") as fh:
            for fid in runtime.passage_ids:
                fh.write(struct.pack(
                    "<%df" % len(runtime._passages[fid]),
                    *runtime._passages[fid]))
        with open(ids_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(runtime.passage_ids, fh, ensure_ascii=False)
        index_evidence = {
            "index_dir": index_dir,
            "dimension": 768,
            "dtype": "float32",
            "object_count": len(runtime.passage_ids),
            "vectors_bytes": os.path.getsize(vectors_path),
            "vectors_sha256": _sha_file(vectors_path),
            "object_ids_sha256": _sha_file(ids_path),
            "vector_table_sha256": runtime.vector_table_digest,
            "rebuild_command": "重跑本 runner（索引由冻结夹具 + 固定 "
                               "revision 模型完整重建；目录可删除）",
        }

    # ---- 物化 + baseline（词法路径 top5）----
    root, repos = G0._materialize_cases(cases, fixtures)
    try:
        baseline_top5 = {}
        for case in cases:
            primary = G0._recall(case, repos[case["case_id"]])
            baseline_top5[case["case_id"]] = primary["returned_ids"][:5]

        # ---- 35-grid 主运行 ----
        tau_grid = lock["grid"]["tau"]
        alpha_grid = lock["grid"]["alpha"]
        rows = []
        trace_diffs = []
        conflict_loser_revivals = 0
        runtime_hard_consistent = True
        first_runtime_hard = {}
        started = time.perf_counter()
        for alpha in alpha_grid:
            for tau in tau_grid:
                verdicts = []
                grid_runtime_hard = {}
                for case in cases:
                    primary = G0._recall(
                        case, repos[case["case_id"]], semantic_mode="test",
                        runtime=runtime, alpha=alpha, tau=tau)
                    case_hard = OV.extract_runtime_hard_filter_codes(
                        primary.get("trace"))
                    grid_runtime_hard[case["case_id"]] = case_hard

                    oracle_case = oracle_results[case["case_id"]]
                    survivors = set(oracle_case["survivors"])
                    eligible = sorted(
                        set(case["expected_relevant_ids"]) & survivors)

                    # CONFLICT_LOSER 复活显式检查（硬失败语义）
                    excluded_losers = {
                        entry.get("memory_id")
                        for entry in (
                            (primary.get("trace") or {}).get("excluded", []))
                        if "CONFLICT_LOSER" in (
                            entry.get("reason_codes") or [])}
                    revived = excluded_losers & set(
                        primary["returned_ids"])
                    if revived:
                        conflict_loser_revivals += len(revived)

                    verdicts.append(_e5base_verdict(
                        case, primary, eligible))
                # Trace 一致性（逐 case，整轮硬失败语义）
                for case in cases:
                    case_diffs = OV.compare_traces(
                        oracle_results, case,
                        grid_runtime_hard[case["case_id"]])
                    if case_diffs:
                        trace_diffs.extend(case_diffs)
                    if case["case_id"] in first_runtime_hard:
                        if first_runtime_hard[case["case_id"]] != \
                                grid_runtime_hard[case["case_id"]]:
                            runtime_hard_consistent = False
                    else:
                        first_runtime_hard[case["case_id"]] = \
                            grid_runtime_hard[case["case_id"]]

                if trace_diffs:
                    # canonical / runtime Trace 不一致 → 整轮 FAIL（立即停止）
                    break

                raw, counts, reasons = G0.raw_metrics(
                    verdicts, baseline_top5=baseline_top5)
                contract = metrics_v2.compute_v2_slice(verdicts)
                if contract["returned_objects"] != counts[
                        "returned_objects"] or \
                        contract["wrong_objects"] != counts[
                            "false_objects"] or \
                        contract["golden_ids"] != counts["critical_total"]:
                    raise E5BaseCalibrationError(
                        "METRIC_CONTRACT_COUNT_MISMATCH")
                rows.append({
                    "alpha": alpha, "tau": tau,
                    "raw_metrics": raw, "raw_counts": counts,
                    "metric_contract_v2_rounded": contract,
                    "qualifying": not reasons,
                    "elimination_reasons": reasons,
                    "_verdicts": verdicts,
                })
            if trace_diffs:
                break
        elapsed = time.perf_counter() - started

        winner = G0.select_winner(rows)
        diagnostic = winner or min(rows, key=G0._selection_key)
        selected_verdicts = winner.get("_verdicts", []) if winner else []
        diagnostic_verdicts = diagnostic.get("_verdicts", [])
        for row in rows:
            row.pop("_verdicts", None)
        selected_public = None
        if winner:
            selected_public = {k: v for k, v in winner.items()
                               if not k.startswith("_")}
        diagnostic_public = {k: v for k, v in diagnostic.items()
                             if not k.startswith("_")}

        # ---- receipt（证据不含 query / content / 向量 / secret 样值）----
        result_probe = json.dumps(
            {"rows": rows, "diagnostic_verdicts": diagnostic_verdicts,
             "selected_verdicts": selected_verdicts,
             "oracle_results": oracle_results},
            ensure_ascii=False, sort_keys=True)
        secret_leaks = 1 if synthetic_secret in result_probe else 0

        code_path = os.path.abspath(__file__)
        oracle_path = os.path.abspath(
            os.path.join(os.path.dirname(code_path), "oracle_v3.py"))
        embedder_path = os.path.abspath(
            os.path.join(os.path.dirname(code_path), "embedder.py"))
        try:
            head = subprocess.run(
                ["git", "-C", REPO_ROOT, "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()
        except Exception:
            head = None

        if trace_diffs:
            result = "TRACE_MISMATCH_FAIL"
        elif conflict_loser_revivals:
            result = "CONFLICT_LOSER_REVIVAL_FAIL"
        elif secret_leaks:
            result = "SECRET_IN_EVIDENCE_FAIL"
        elif winner:
            result = "PASS"
        elif not rows:
            result = "RUN_INCOMPLETE_FAIL"
        else:
            result = "NO-GO"

        receipt = {
            "schema_version": CALIBRATION_SCHEMA_VERSION,
            "run_label": label,
            "result": result,
            "calibration_case_count": len(cases),
            "loaded_case_ids": [case["case_id"] for case in cases],
            "loaded_case_ids_sha256": G0._ordered_ids_sha(
                [case["case_id"] for case in cases]),
            "holdout_detail_reads": 0,
            "grid_count": len(rows),
            "grid": {"alpha": alpha_grid, "tau": tau_grid},
            "grid_combination_count_expected": EXPECTED_GRID_COUNT,
            "qualifying_count": sum(
                row.get("qualifying", False) for row in rows),
            "hard_gate_reference": HARD_GATE_REFERENCE,
            "selected": selected_public,
            "best_observed_nonqualifying": (
                diagnostic_public if winner is None else None),
            "grid_results": rows,
            "selected_case_verdicts": selected_verdicts,
            "diagnostic_case_verdicts": diagnostic_verdicts,
            "trace_consistency": {
                "canonical_oracle": "memory_eval/e5_base/oracle_v3.py "
                                    "(independent implementation)",
                "oracle_results_sha256": oracle_digest,
                "runtime_hard_filter_consistent_across_grid":
                    runtime_hard_consistent,
                "trace_mismatch_count": len(trace_diffs),
                "trace_mismatch_examples": trace_diffs[:20],
                "conflict_loser_revivals": conflict_loser_revivals,
                "conflict_loser_policy": "CONFLICT_LOSER 不得被向量路径复活；"
                                         "复活 = 整轮 FAIL",
            },
            "eligible_expected_rule": "eligible_expected = "
                                      "frozen_expected ∩ canonical_survivors"
                                      "（oracle v3 口径）",
            "eligible_expected_counts": {
                case["case_id"]: len(
                    set(case["expected_relevant_ids"]) &
                    set(oracle_results[case["case_id"]]["survivors"]))
                for case in cases
            },
            "integrity": {
                "git_head": head,
                "calibration_code_sha256": _sha_file(code_path),
                "oracle_v3_code_sha256": _sha_file(oracle_path),
                "embedder_code_sha256": _sha_file(embedder_path),
                "e5_base_runner_gate0_sha256": _sha_file(
                    os.path.abspath(G0.__file__)),
                "calibration_lock_sha256": _sha_file(G0.LOCK_PATH),
                "candidate_lock_sha256": _sha_file(CANDIDATE_LOCK_PATH),
                "lock_digests_measured": lock_digests,
                "frozen_sources": calib_lock["source_files"],
                "sealed_inputs": calib_lock["sealed_inputs"],
                "model_manifest_sha256": runtime.manifest_digest,
                "calibration_vector_table_sha256":
                    runtime.vector_table_digest,
            },
            "runtime": {
                "model": runtime.trace_model(),
                "passage_embedding_count": len(runtime.passage_ids),
                "query_embedding_count": runtime.query_embedding_count,
                "score_call_count": runtime.score_call_count,
                "scored_candidate_count": len(runtime.scored_candidate_ids),
                "grid_elapsed_seconds": elapsed,
                "torch_version": torch.__version__,
            },
            "derived_index": index_evidence,
            "evidence_secret_leak_count": secret_leaks,
            "protocol_deviations": [],
        }
        os.makedirs(os.path.dirname(os.path.abspath(output_json)),
                    exist_ok=True)
        with open(output_json, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(receipt, fh, ensure_ascii=False, sort_keys=True,
                      indent=2)
            fh.write("\n")
        _write_markdown(output_markdown, receipt)
        return receipt
    finally:
        from memory_engine import paths as engine_paths
        engine_paths.set_repo(REPO_ROOT)
        shutil.rmtree(root, ignore_errors=True)


def _e5base_verdict(case, primary, eligible_expected):
    """E5-base 口径 verdict：expected = eligible_expected（oracle v3 交集）。"""
    returned = primary["returned_ids"]
    expected = set(eligible_expected)
    forbidden = set(case["forbidden_ids"])
    ret = set(returned)
    trace = primary.get("trace") or {}
    reason_codes = {}
    for entry in trace.get("excluded", []):
        mid = entry.get("memory_id")
        if mid in expected or mid in forbidden:
            reason_codes[mid] = list(entry.get("reason_codes") or [])
    return {
        "case_id": case["case_id"],
        "category": case["category"],
        "returned_ids": returned,
        # oracle v3 口径：expected_relevant_ids = eligible_expected
        # （frozen_expected ∩ canonical_survivors，供 raw_metrics 复用）
        "expected_relevant_ids": list(eligible_expected),
        "eligible_expected_ids": list(eligible_expected),
        "frozen_expected_ids": list(case["expected_relevant_ids"]),
        "excluded_from_expected_by_oracle": sorted(
            set(case["expected_relevant_ids"]) - expected),
        "forbidden_ids": list(case["forbidden_ids"]),
        "forbidden_hits": sorted(ret & forbidden),
        "missed": sorted(expected - ret),
        "extra": sorted(ret - expected),
        "no_memory_expected": bool(case["expected_no_memory"]),
        "no_memory_violated": bool(case["expected_no_memory"] and returned),
        "reason_codes": reason_codes,
        "selected_reason_codes": {
            entry.get("memory_id"): list(entry.get("reason_codes") or [])
            for entry in trace.get("selected", []) if entry.get("memory_id")
        },
        "semantic_status": primary.get("semantic_status"),
        "error": primary.get("error"),
        "tokens": primary.get("tokens", 0),
        "latency_ms": primary.get("latency_ms", 0.0),
    }


def _write_markdown(path, receipt):
    lines = [
        "# E5-base Calibration Receipt（%s）" % receipt.get("run_label", ""),
        "",
        "- Result: **%s**" % receipt["result"],
        "- Calibration cases loaded: **%d**"
        % receipt["calibration_case_count"],
        "- Holdout detail reads: **0**",
        "- Grid combinations: **%d / %d**" % (
            receipt["grid_count"], receipt["grid_combination_count_expected"]),
        "- Qualifying combinations: **%d**" % receipt["qualifying_count"],
        "- Canonical oracle results SHA-256: `%s`"
        % receipt["trace_consistency"]["oracle_results_sha256"],
        "- Trace mismatch count: **%d**"
        % receipt["trace_consistency"]["trace_mismatch_count"],
        "- CONFLICT_LOSER revivals: **%d**"
        % receipt["trace_consistency"]["conflict_loser_revivals"],
        "- Model manifest SHA-256: `%s`"
        % receipt["integrity"]["model_manifest_sha256"],
        "- Calibration vector table SHA-256: `%s`"
        % receipt["integrity"]["calibration_vector_table_sha256"],
        "- Protocol deviations: **none**",
        "",
    ]
    if receipt.get("selected"):
        sel = receipt["selected"]
        lines.extend([
            "## Frozen selection", "",
            "- alpha: **%.2f**" % sel["alpha"],
            "- tau: **%.2f**" % sel["tau"],
            "- precision_at5_v2: %.12f"
            % sel["raw_metrics"]["precision_at5_v2"],
            "- critical_memory_recall_v2: %.12f"
            % sel["raw_metrics"]["critical_memory_recall_v2"],
            "- false_recall_rate_v2: %.12f"
            % sel["raw_metrics"]["false_recall_rate_v2"],
            "- prompt token P95: %s"
            % sel["raw_metrics"]["prompt_token_p95"], "",
        ])
    elif receipt["result"] == "NO-GO" and receipt.get(
            "best_observed_nonqualifying"):
        diag = receipt["best_observed_nonqualifying"]
        failed_cases = [v for v in receipt["diagnostic_case_verdicts"]
                        if v["missed"] or v["extra"] or
                        v["forbidden_hits"] or v["error"]]
        lines.extend([
            "## Best observed non-qualifying point", "",
            "- alpha: **%.2f**" % diag["alpha"],
            "- tau: **%.2f**" % diag["tau"],
            "- elimination reasons: `%s`" % ", ".join(
                diag["elimination_reasons"]),
            "- discrepant cases: **%s**" % ", ".join(
                v["case_id"] for v in failed_cases), "",
            "## Stop condition", "",
            "No grid combination met every calibration hard gate. E5-base "
            "is **NO-GO** under this frozen 35-combination contract. "
            "Gate 0-F must not run.", "",
        ])
    elif receipt["result"].endswith("FAIL"):
        lines.extend([
            "## Hard failure", "",
            "- trace mismatch examples: %s" % json.dumps(
                receipt["trace_consistency"]["trace_mismatch_examples"]
                [:5], ensure_ascii=False),
            "", "本轮按裁决硬失败语义终止；禁止缩减 expected / 跳过 case / "
            "放宽校验继续。", "",
        ])
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))


DETERMINISTIC_FIELDS = (
    "result", "calibration_case_count", "loaded_case_ids",
    "loaded_case_ids_sha256", "grid_count", "grid",
    "grid_combination_count_expected", "qualifying_count", "selected",
    "best_observed_nonqualifying", "grid_results",
    "selected_case_verdicts", "diagnostic_case_verdicts",
    "trace_consistency", "eligible_expected_counts", "integrity",
    "runtime.passage_embedding_count",
    "runtime.query_embedding_count",
    "runtime.score_call_count",
    "runtime.scored_candidate_count",
    "runtime.model",
    "derived_index",
)


def _strip_latency(value):
    """递归剥离延迟/运行参数类字段（确定性比较排除延迟与落盘路径，
    E5-small 轮口径：延迟与运行时长不纳入确定性比较）。"""
    if isinstance(value, dict):
        return {
            k: _strip_latency(v) for k, v in value.items()
            if k not in ("latency_ms", "grid_elapsed_seconds",
                         "build_duration_ms", "index_dir",
                         "rebuild_command", "run_label")
        }
    if isinstance(value, list):
        return [_strip_latency(v) for v in value]
    return value


def compare_receipts(receipt_a, receipt_b):
    """确定性复验比较：剥离时间/延迟字段后逐字段一致。"""
    def _pick(receipt):
        out = {}
        for field in DETERMINISTIC_FIELDS:
            if "." in field:
                outer, inner = field.split(".", 1)
                if outer in receipt and inner in receipt.get(outer, {}):
                    out[field] = _strip_latency(receipt[outer][inner])
            elif field in receipt:
                out[field] = _strip_latency(receipt[field])
        return out

    a, b = _pick(receipt_a), _pick(receipt_b)
    diffs = []
    for key in sorted(set(a) | set(b)):
        if a.get(key) != b.get(key):
            diffs.append(key)
    return diffs, a


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="E5-base sealed calibration (35-grid + oracle v3)")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-markdown", required=True)
    parser.add_argument("--index-dir", default=None,
                        help="仓库外派生索引落盘目录（可删除可重建）")
    parser.add_argument("--run-label", default="main")
    parser.add_argument("--compare-with", default=None,
                        help="复验模式：与该 receipt JSON 比对确定性字段")
    args = parser.parse_args(argv)

    receipt = run_calibration(
        args.model_dir, args.output_json, args.output_markdown,
        index_dir=args.index_dir, label=args.run_label)

    if args.compare_with:
        with open(args.compare_with, "r", encoding="utf-8") as fh:
            other = json.load(fh)
        diffs, _ = compare_receipts(other, receipt)
        comparison = {
            "deterministic_fields_compared": len(DETERMINISTIC_FIELDS),
            "mismatched_fields": diffs,
            "deterministic_replay_ok": not diffs,
        }
        compare_path = args.output_json.replace(
            ".json", ".replay-verification.json")
        with open(compare_path, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(comparison, fh, ensure_ascii=False, sort_keys=True,
                      indent=2)
            fh.write("\n")
        print(json.dumps({
            "result": receipt["result"],
            "qualifying_count": receipt["qualifying_count"],
            "selected": receipt["selected"],
            "deterministic_replay_ok": not diffs,
        }, ensure_ascii=False, sort_keys=True))
        return 0 if (receipt["result"] == "PASS" and not diffs) else 2

    print(json.dumps({
        "result": receipt["result"],
        "qualifying_count": receipt["qualifying_count"],
        "selected": receipt["selected"],
    }, ensure_ascii=False, sort_keys=True))
    return 0 if receipt["result"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
