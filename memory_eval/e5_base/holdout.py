# -*- coding: utf-8 -*-
"""E5-base 一次性 holdout acceptance runner（R4 Gate 0-F，F0A 冻结）。

协议（产品所有者指令 2026-08-22）：
- F0A 冻结本 runner；F0B 从 F0A clean HEAD 执行唯一一次真实运行。
- 参数硬编码 alpha=1.00 / tau=0.90（正式 calibration 选择固定值）；
  无网格、无选参、无调参、无降门槛路径。
- 仅根据 frozen split manifest（frozen-eval-manifest.json
  split_contract.holdout_ids）装载精确 58 个 holdout cases；
  paraphrase cases 必须在同一次运行中完成。
- preflight（读取任何 holdout detail 之前）依次加载并验证：正式
  calibration receipt、candidate lock、model manifest、
  代码 / 语料 / fixture / index digest。
- 外置原子 one-shot consumption marker：全部 preflight 通过后、读取
  第一条 holdout detail 之前，以 O_CREAT|O_EXCL 原子写入。marker 已
  存在（或任何 holdout detail 已被读取）即视为唯一运行已消费：禁止
  第二次运行、replay、重试、调参、修例外或重新分组。
- 消费后崩溃或证据不完整 → 记录 CONSUMED / INDETERMINATE，同样禁止
  自行重跑。
- 任一门槛失败 → HOLDOUT FAIL / NO-GO（同样禁止第二次运行）。
- 本模块源码不包含任何 holdout case 细节（query / expected /
  forbidden / 夹具内容一律运行时从冻结语料装载）。
"""

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_eval import gate0_calibration as G0  # noqa: E402
from memory_eval import metrics as metrics_v2  # noqa: E402
from memory_eval.e5_base import calibration as CAL  # noqa: E402
from memory_eval.e5_base import oracle_v3 as OV  # noqa: E402

CANDIDATE_LOCK_PATH = CAL.CANDIDATE_LOCK_PATH
CONTRACT_PATH = CAL.CONTRACT_PATH
HOLDOUT_MANIFEST_PATH = CAL.HOLDOUT_MANIFEST_PATH
CALIBRATION_RECEIPT_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "evidence",
    "e5-base-calibration-results.json")
MODEL_MANIFEST_EVIDENCE_PATH = os.path.join(
    REPO_ROOT, "docs", "r4-gate0", "evidence",
    "e5-base-model-manifest.json")
FIXTURES_PATH = os.path.join(
    REPO_ROOT, "tests", "fixtures", "memory_eval", "fixtures.json")

HOLDOUT_SCHEMA_VERSION = "r4-gate0-e5base-holdout-v1"
MARKER_SCHEMA_VERSION = "r4-gate0-e5base-holdout-consumption-v1"

# ---- 正式 calibration 选择固定值（禁止任何形式的参数搜索）----
FROZEN_ALPHA = 1.0
FROZEN_TAU = 0.90

EXPECTED_HOLDOUT_COUNT = 58
EXPECTED_CALIBRATION_COUNT = 53
EXPECTED_TOTAL_NO_MEMORY = 41
EXPECTED_PARAPHRASE_COUNT = 12
PARAPHRASE_MIN_CORRECT = 11
PRECISION_MIN = 0.90
CRITICAL_RECALL_MIN = 0.95
FALSE_RECALL_MAX = 0.02
TOKEN_P95_MAX = 650

HOLDOUT_GATE_REFERENCE = (
    "precision_at5_v2>=0.90; critical_memory_recall_v2>=0.95; "
    "false_recall_rate_v2<=0.02; paraphrase>=11/12; "
    "NO MEMORY final contract 41/41; "
    "lexical_expected_preservation==1.0; prompt_token_p95<=650; "
    "scope/superseded/conflict/secret/forbidden leakage==0; "
    "conflict_loser_revival==0; trace_mismatch==0; error_count==0")


class E5BaseHoldoutError(RuntimeError):
    pass


class HoldoutConsumedError(E5BaseHoldoutError):
    pass


def _sha_file(path):
    return G0._sha_file(path)


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _git_head():
    try:
        return subprocess.run(
            ["git", "-C", REPO_ROOT, "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


# ============================================================
# Phase 1：preflight（此阶段零 holdout detail 读取，仅字节级
# digest 校验与已提交公开证据 / 元数据解析）
# ============================================================

def check_calibration_receipt_contract(receipt, measured):
    """纯契约校验（零文件 IO；实测值由调用方注入，供合成测试复用）。

    measured = {
        "candidate_lock_sha256": str,
        "lock_digests": {...},
        "code_digests": {"calibration_code_sha256": ..., ...},
        "frozen_sources": {rel_path: sha256, ...},
    }
    """
    if receipt.get("schema_version") != CAL.CALIBRATION_SCHEMA_VERSION:
        raise E5BaseHoldoutError("CALIBRATION_RECEIPT_SCHEMA_MISMATCH")
    if receipt.get("result") != "PASS":
        raise E5BaseHoldoutError("CALIBRATION_RECEIPT_NOT_PASS")
    if receipt.get("holdout_detail_reads") != 0:
        raise E5BaseHoldoutError("CALIBRATION_RECEIPT_HOLDOUT_READS_NONZERO")
    if receipt.get("protocol_deviations") != []:
        raise E5BaseHoldoutError("CALIBRATION_RECEIPT_DEVIATIONS_NONEMPTY")
    selected = receipt.get("selected") or {}
    if selected.get("alpha") != FROZEN_ALPHA or \
            selected.get("tau") != FROZEN_TAU:
        raise E5BaseHoldoutError(
            "CALIBRATION_SELECTION_MISMATCH_FROZEN_PARAMS")
    if selected.get("qualifying") is not True:
        raise E5BaseHoldoutError("CALIBRATION_SELECTION_NOT_QUALIFYING")

    integrity = receipt.get("integrity") or {}
    if integrity.get("candidate_lock_sha256") != \
            measured["candidate_lock_sha256"]:
        raise E5BaseHoldoutError("CALIBRATION_RECEIPT_LOCK_DRIFT")
    if integrity.get("lock_digests_measured") != measured["lock_digests"]:
        raise E5BaseHoldoutError("CALIBRATION_RECEIPT_LOCK_DIGEST_DRIFT")

    # 代码 digest：receipt 钉定的实现与当前磁盘逐项一致（零漂移）
    for key in sorted(measured["code_digests"]):
        if integrity.get(key) != measured["code_digests"][key]:
            raise E5BaseHoldoutError("CALIBRATION_CODE_DRIFT:" + key)

    # 语料 / fixture digest：冻结源与当前磁盘逐项一致
    frozen_sources = integrity.get("frozen_sources") or {}
    if frozen_sources != measured["frozen_sources"]:
        raise E5BaseHoldoutError("FROZEN_SOURCE_DRIFT")

    # 正式选择的 NO MEMORY 基线（最终合同 41/41 的 calibration 部分）
    raw_counts = selected.get("raw_counts") or {}
    if raw_counts.get("no_memory_correct") != \
            raw_counts.get("no_memory_total"):
        raise E5BaseHoldoutError("CALIBRATION_NO_MEMORY_NOT_ALL_CORRECT")
    return receipt


def verify_calibration_receipt(lock, lock_digests):
    """加载正式 calibration receipt 并与当前仓库逐项实测锚定。"""
    receipt = _load_json(CALIBRATION_RECEIPT_PATH)
    measured = {
        "candidate_lock_sha256": _sha_file(CANDIDATE_LOCK_PATH),
        "lock_digests": lock_digests,
        "code_digests": {
            "calibration_code_sha256": _sha_file(
                os.path.abspath(CAL.__file__)),
            "oracle_v3_code_sha256": _sha_file(
                os.path.abspath(OV.__file__)),
            "embedder_code_sha256": _sha_file(os.path.join(
                os.path.dirname(os.path.abspath(CAL.__file__)),
                "embedder.py")),
            "e5_base_runner_gate0_sha256": _sha_file(
                os.path.abspath(G0.__file__)),
        },
        "frozen_sources": {
            rel: _sha_file(os.path.join(REPO_ROOT, *rel.split("/")))
            for rel in ("docs/r4-gate0/evidence/frozen-eval-manifest.json",
                        "memory_eval/corpus.py",
                        "memory_eval/metrics.py",
                        "memory_eval/runner.py",
                        "tests/fixtures/memory_eval/fixtures.json")
        },
    }
    return check_calibration_receipt_contract(receipt, measured)


def verify_model_manifest(model_dir, receipt):
    """model manifest 三方一致：模型目录 = receipt 锚定 = 证据副本。"""
    from memory_eval.e5_base.supply_chain import MANIFEST_FILENAME
    runtime_model = (receipt.get("runtime") or {}).get("model") or {}
    integrity = receipt.get("integrity") or {}
    expected = runtime_model.get("manifest_digest")
    if not expected or expected != integrity.get(
            "model_manifest_sha256"):
        raise E5BaseHoldoutError("MODEL_MANIFEST_ANCHOR_INCONSISTENT")
    path = os.path.join(model_dir, MANIFEST_FILENAME)
    if not os.path.isfile(path):
        raise E5BaseHoldoutError("MODEL_MANIFEST_MISSING")
    if _sha_file(path) != expected:
        raise E5BaseHoldoutError("MODEL_MANIFEST_DIGEST_MISMATCH")
    if _sha_file(MODEL_MANIFEST_EVIDENCE_PATH) != expected:
        raise E5BaseHoldoutError("MODEL_MANIFEST_EVIDENCE_DRIFT")
    return expected


def verify_calibration_index(receipt, index_dir=None):
    """calibration 主运行派生索引 digest 复验（证据链完整性）。"""
    idx = receipt.get("derived_index") or {}
    root = index_dir or idx.get("index_dir")
    if not root:
        raise E5BaseHoldoutError("CALIBRATION_INDEX_DIR_UNKNOWN")
    checks = {
        "vectors.f32": idx.get("vectors_sha256"),
        "object_ids.json": idx.get("object_ids_sha256"),
    }
    for name in sorted(checks):
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            raise E5BaseHoldoutError(
                "CALIBRATION_INDEX_FILE_MISSING:" + name)
        if _sha_file(path) != checks[name]:
            raise E5BaseHoldoutError("CALIBRATION_INDEX_DRIFT:" + name)
    return {
        "index_dir": root,
        "vectors_sha256": idx.get("vectors_sha256"),
        "object_ids_sha256": idx.get("object_ids_sha256"),
        "vector_table_sha256": idx.get("vector_table_sha256"),
    }


def load_frozen_split():
    """仅根据 frozen split manifest 提取 58 个 holdout IDs 及合同口径。"""
    manifest = _load_json(HOLDOUT_MANIFEST_PATH)
    sc = manifest.get("split_contract") or {}
    holdout_ids = sc.get("holdout_ids") or []
    calibration_ids = sc.get("calibration_ids") or []
    if sc.get("holdout_count") != EXPECTED_HOLDOUT_COUNT or \
            len(holdout_ids) != EXPECTED_HOLDOUT_COUNT:
        raise E5BaseHoldoutError("HOLDOUT_COUNT_MISMATCH")
    if sc.get("calibration_count") != EXPECTED_CALIBRATION_COUNT or \
            len(calibration_ids) != EXPECTED_CALIBRATION_COUNT:
        raise E5BaseHoldoutError("CALIBRATION_COUNT_MISMATCH")
    if len(set(holdout_ids)) != len(holdout_ids) or \
            len(set(calibration_ids)) != len(calibration_ids):
        raise E5BaseHoldoutError("SPLIT_IDS_NOT_UNIQUE")
    if set(holdout_ids) & set(calibration_ids):
        raise E5BaseHoldoutError("SPLIT_OVERLAP")
    if G0._ordered_ids_sha(holdout_ids) != sc.get("holdout_ids_sha256"):
        raise E5BaseHoldoutError("HOLDOUT_IDS_SHA_MISMATCH")
    if G0._ordered_ids_sha(calibration_ids) != sc.get(
            "calibration_ids_sha256"):
        raise E5BaseHoldoutError("CALIBRATION_IDS_SHA_MISMATCH")
    corpus = manifest.get("corpus") or {}
    if corpus.get("case_count") != (EXPECTED_HOLDOUT_COUNT +
                                    EXPECTED_CALIBRATION_COUNT):
        raise E5BaseHoldoutError("CORPUS_COUNT_MISMATCH")
    no_memory_ids = corpus.get("no_memory_case_ids") or []
    paraphrase_ids = corpus.get("paraphrase_case_ids") or []
    if len(no_memory_ids) != EXPECTED_TOTAL_NO_MEMORY:
        raise E5BaseHoldoutError("NO_MEMORY_COUNT_MISMATCH")
    if len(paraphrase_ids) != EXPECTED_PARAPHRASE_COUNT:
        raise E5BaseHoldoutError("PARAPHRASE_COUNT_MISMATCH")
    if not set(paraphrase_ids) <= set(holdout_ids):
        raise E5BaseHoldoutError("PARAPHRASE_NOT_ALL_IN_HOLDOUT")
    return manifest, holdout_ids, no_memory_ids, paraphrase_ids


# ============================================================
# Phase 2：外置原子 one-shot consumption marker
# ============================================================

def assert_not_consumed(marker_path):
    if os.path.exists(marker_path):
        raise HoldoutConsumedError(
            "ONE_SHOT_ALREADY_CONSUMED: marker %s 已存在；唯一一次 "
            "E5-base holdout 运行已被消费，禁止第二次运行 / replay / "
            "重试 / 调参 / 修例外 / 重新分组。" % marker_path)


def build_marker_payload(git_head, holdout_ids, model_manifest_sha,
                         runner_sha, receipt_sha):
    return {
        "schema_version": MARKER_SCHEMA_VERSION,
        "run_kind": "e5-base-holdout-one-shot",
        "consumed_at_utc": time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "git_head": git_head,
        "parameters_frozen": {"alpha": FROZEN_ALPHA, "tau": FROZEN_TAU},
        "holdout_case_count": len(holdout_ids),
        "holdout_ids_sha256": G0._ordered_ids_sha(holdout_ids),
        "model_manifest_sha256": model_manifest_sha,
        "candidate_lock_sha256": _sha_file(CANDIDATE_LOCK_PATH),
        "calibration_receipt_sha256": receipt_sha,
        "holdout_runner_code_sha256": runner_sha,
        "policy": "one-shot：本 marker 的存在即代表唯一一次 E5-base "
                  "holdout 运行已被消费（写入发生在全部 preflight 通过"
                  "之后、读取第一条 holdout detail 之前）；此后禁止第二"
                  "次运行、replay、重试、调参、修例外或重新分组。",
    }


def write_consumption_marker(marker_path, payload):
    """原子 one-shot 写入：O_CREAT|O_EXCL，已存在即消费拒绝。"""
    parent = os.path.dirname(os.path.abspath(marker_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     indent=2).encode("utf-8") + b"\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(
        os, "O_BINARY", 0)
    try:
        fd = os.open(marker_path, flags)
    except FileExistsError:
        raise HoldoutConsumedError(
            "ONE_SHOT_ALREADY_CONSUMED: marker %s 已存在。" % marker_path)
    try:
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    return hashlib.sha256(raw).hexdigest()


# ============================================================
# Phase 3：holdout 装载与运行（marker 写入后才允许读取 detail）
# ============================================================

def select_holdout_cases(all_cases, holdout_ids, paraphrase_ids,
                         validator=None):
    """仅按 manifest ID 清单精确选取 holdout cases（含完整性校验）。"""
    by_id = {}
    for case in all_cases:
        cid = case.get("case_id")
        if cid in by_id:
            raise E5BaseHoldoutError(
                "CORPUS_DUPLICATE_CASE_ID:" + str(cid))
        by_id[cid] = case
    missing = [i for i in holdout_ids if i not in by_id]
    if missing:
        raise E5BaseHoldoutError(
            "HOLDOUT_ID_NOT_IN_CORPUS:" + ",".join(missing))
    cases = [by_id[i] for i in holdout_ids]
    if len(cases) != len(holdout_ids):
        raise E5BaseHoldoutError("HOLDOUT_CASE_COUNT_MISMATCH")
    if not set(paraphrase_ids) <= {c["case_id"] for c in cases}:
        raise E5BaseHoldoutError("PARAPHRASE_CASES_INCOMPLETE")
    if validator is not None:
        for pos, case in enumerate(cases):
            ok, errors = validator(case, pos)
            if not ok:
                raise E5BaseHoldoutError(
                    "INVALID_HOLDOUT_CASE:" + "; ".join(errors))
    return cases


def load_holdout_bundle(holdout_ids, paraphrase_ids):
    """读取冻结语料与全量夹具，精确选取 58 个 holdout cases。

    仅在本函数（即 marker 写入之后）才解析 holdout case detail。
    """
    from memory_eval import corpus as corpus_module
    from memory_eval import schema as eval_schema
    cases = select_holdout_cases(
        corpus_module.CASES, holdout_ids, paraphrase_ids,
        validator=eval_schema.validate_case)
    if len(cases) != EXPECTED_HOLDOUT_COUNT:
        raise E5BaseHoldoutError("HOLDOUT_CASE_COUNT_MISMATCH")
    fixtures_payload = _load_json(FIXTURES_PATH)
    fixtures = fixtures_payload.get("fixtures") or {}
    used = sorted({fid for case in cases for fid in case.get("fixtures", [])})
    for fid in used:
        if fid not in fixtures:
            raise E5BaseHoldoutError("HOLDOUT_FIXTURE_MISSING:" + fid)
    return cases, fixtures


def paraphrase_correct(verdict):
    """paraphrase case 正确 = 改写目标命中 Top-5 且零 forbidden / 零错误。"""
    eligible = set(verdict.get("eligible_expected_ids") or [])
    top5 = set((verdict.get("returned_ids") or [])[:5])
    return bool(eligible) and eligible <= top5 and \
        not verdict.get("forbidden_hits") and not verdict.get("error")


def leakage_breakdown(verdicts, cases_by_id, conflict_loser_revivals,
                      evidence_secret_leak_count):
    scope = superseded = secret = forbidden_total = 0
    for v in verdicts:
        critical = set(
            (cases_by_id.get(v["case_id"]) or {}).get(
                "critical_assertions") or [])
        hits = len(v.get("forbidden_hits") or [])
        forbidden_total += hits
        if "no_scope_leak" in critical:
            scope += hits
        if "no_superseded_leak" in critical:
            superseded += hits
        if "no_secret_leak" in critical:
            secret += hits
    return {
        "scope_leakage": scope,
        "superseded_leakage": superseded,
        "conflict_loser_revival": conflict_loser_revivals,
        "secret_leakage": secret + evidence_secret_leak_count,
        "forbidden_leakage_total": forbidden_total,
    }


def evaluate_gates(raw, pp_correct, no_memory_combined_correct,
                   no_memory_combined_total, leakage,
                   trace_mismatch_count, error_count):
    def gate(name, value, rule, passed):
        return {"gate": name, "value": value, "rule": rule,
                "passed": bool(passed)}

    gates = [
        gate("precision_at5_v2", raw["precision_at5_v2"], ">=0.90",
             raw["precision_at5_v2"] is not None and
             raw["precision_at5_v2"] >= PRECISION_MIN),
        gate("critical_memory_recall_v2", raw["critical_memory_recall_v2"],
             ">=0.95",
             raw["critical_memory_recall_v2"] is not None and
             raw["critical_memory_recall_v2"] >= CRITICAL_RECALL_MIN),
        gate("false_recall_rate_v2", raw["false_recall_rate_v2"], "<=0.02",
             raw["false_recall_rate_v2"] is not None and
             raw["false_recall_rate_v2"] <= FALSE_RECALL_MAX),
        gate("paraphrase_correct",
             "%d/%d" % (pp_correct, EXPECTED_PARAPHRASE_COUNT),
             ">=11/12", pp_correct >= PARAPHRASE_MIN_CORRECT),
        gate("no_memory_final_contract",
             "%d/%d" % (no_memory_combined_correct,
                        no_memory_combined_total),
             "41/41 all correct",
             no_memory_combined_total == EXPECTED_TOTAL_NO_MEMORY and
             no_memory_combined_correct == EXPECTED_TOTAL_NO_MEMORY),
        gate("lexical_expected_preservation",
             raw["lexical_expected_preservation"], "==1.0",
             raw["lexical_expected_preservation"] == 1.0),
        gate("prompt_token_p95", raw["prompt_token_p95"], "<=650",
             raw["prompt_token_p95"] is not None and
             raw["prompt_token_p95"] <= TOKEN_P95_MAX),
        gate("scope_leakage", leakage["scope_leakage"], "==0",
             leakage["scope_leakage"] == 0),
        gate("superseded_leakage", leakage["superseded_leakage"], "==0",
             leakage["superseded_leakage"] == 0),
        gate("conflict_loser_revival", leakage["conflict_loser_revival"],
             "==0", leakage["conflict_loser_revival"] == 0),
        gate("secret_leakage", leakage["secret_leakage"], "==0",
             leakage["secret_leakage"] == 0),
        gate("forbidden_leakage_total", leakage["forbidden_leakage_total"],
             "==0", leakage["forbidden_leakage_total"] == 0),
        gate("trace_mismatch", trace_mismatch_count, "==0",
             trace_mismatch_count == 0),
        gate("error_count", error_count, "==0", error_count == 0),
    ]
    return gates, all(g["passed"] for g in gates)


def run_holdout(model_dir, output_json, output_markdown, marker_path,
                calibration_index_dir=None, label="one-shot"):
    """唯一一次 E5-base holdout 运行（one-shot，禁止重复调用）。"""
    # 消费拒绝最先执行：marker 已存在即拒绝做任何工作
    assert_not_consumed(marker_path)

    runner_sha = _sha_file(os.path.abspath(__file__))
    receipt_sha = _sha_file(CALIBRATION_RECEIPT_PATH)

    # ---- Phase 1：preflight（零 holdout detail 读取）----
    lock, lock_digests = CAL.verify_lock_digests()
    receipt = verify_calibration_receipt(lock, lock_digests)
    manifest, holdout_ids, no_memory_ids, paraphrase_ids = \
        load_frozen_split()
    model_manifest_sha = verify_model_manifest(model_dir, receipt)
    index_evidence = verify_calibration_index(
        receipt, calibration_index_dir)
    from memory_eval.e5_base.embedder import verify_backend_versions
    verify_backend_versions()
    git_head = _git_head()

    # ---- Phase 2：one-shot consumption gate ----
    marker_payload = build_marker_payload(
        git_head, holdout_ids, model_manifest_sha, runner_sha, receipt_sha)
    marker_sha = write_consumption_marker(marker_path, marker_payload)
    # 自此刻起：唯一运行已消费。任何后续失败均不得触发重跑。

    base_integrity = {
        "git_head": git_head,
        "schema_version": HOLDOUT_SCHEMA_VERSION,
        "run_label": label,
        "parameters": {
            "alpha": FROZEN_ALPHA, "tau": FROZEN_TAU,
            "frozen": True,
            "selection_source": "正式 calibration receipt（禁止网格 / "
                                "选参 / 调参 / 降门槛）",
        },
        "holdout_gate_reference": HOLDOUT_GATE_REFERENCE,
        "integrity": {
            "git_head": git_head,
            "holdout_runner_code_sha256": runner_sha,
            "calibration_receipt_sha256": receipt_sha,
            "candidate_lock_sha256": _sha_file(CANDIDATE_LOCK_PATH),
            "model_manifest_sha256": model_manifest_sha,
            "oracle_v3_code_sha256": _sha_file(
                os.path.abspath(OV.__file__)),
            "calibration_code_sha256": _sha_file(
                os.path.abspath(CAL.__file__)),
            "e5_base_runner_gate0_sha256": _sha_file(
                os.path.abspath(G0.__file__)),
            "corpus_sha256": _sha_file(os.path.join(
                REPO_ROOT, "memory_eval", "corpus.py")),
            "fixtures_sha256": _sha_file(FIXTURES_PATH),
            "frozen_eval_manifest_sha256": _sha_file(
                HOLDOUT_MANIFEST_PATH),
            "frozen_sources": (receipt.get("integrity") or {}).get(
                "frozen_sources"),
            "lock_digests_measured": lock_digests,
        },
        "consumption_marker": {
            "path": os.path.abspath(marker_path),
            "sha256": marker_sha,
            "content": marker_payload,
            "written_after_all_preflight": True,
            "written_before_first_holdout_detail_read": True,
        },
        "calibration_index_verified": index_evidence,
    }

    # ---- Phase 3：运行（消费后；失败 → CONSUMED / INDETERMINATE）----
    try:
        receipt_out = _execute_holdout(
            model_dir, marker_path, base_integrity, holdout_ids,
            no_memory_ids, paraphrase_ids, receipt, lock_digests)
    except Exception as exc:
        indeterminate = dict(base_integrity)
        indeterminate["result"] = "CONSUMED_INDETERMINATE"
        indeterminate["error"] = "HOLDOUT_EXCEPTION:" + type(exc).__name__
        indeterminate["note"] = (
            "唯一一次运行已在 marker 写入后被消费；本次异常不构成重跑"
            "授权。按协议记录 CONSUMED / INDETERMINATE，禁止自行重跑。")
        _write_outputs(output_json, output_markdown, indeterminate)
        raise

    _write_outputs(output_json, output_markdown, receipt_out)
    return receipt_out


def _execute_holdout(model_dir, marker_path, base_integrity, holdout_ids,
                     no_memory_ids, paraphrase_ids, receipt, lock_digests):
    import shutil
    import torch
    from memory_eval.e5_base.embedder import E5BaseEmbedder

    started = time.perf_counter()
    cases, fixtures = load_holdout_bundle(holdout_ids, paraphrase_ids)
    fixtures, synthetic_secret = G0._runtime_fixture_copy(fixtures)
    cases_by_id = {c["case_id"]: c for c in cases}

    # canonical oracle v3（独立实现；oracle v3 口径）
    oracle = OV.CanonicalOracleV3(
        CONTRACT_PATH, expected_sha256=lock_digests[
            "frozen_hard_filter_contract"])
    oracle_results = oracle.judge_all(cases, fixtures)

    embedder = E5BaseEmbedder(model_dir, device="cpu")
    runtime = G0.CalibrationVectorRuntime(embedder, cases, fixtures)

    root, repos = G0._materialize_cases(cases, fixtures)
    try:
        # 词法基线（lexical_expected_preservation 分子/分母）
        baseline_top5 = {}
        for case in cases:
            primary = G0._recall(case, repos[case["case_id"]])
            baseline_top5[case["case_id"]] = primary["returned_ids"][:5]

        # 唯一一次正式运行：alpha=1.00 / tau=0.90（硬编码，无网格）
        verdicts = []
        trace_diffs = []
        conflict_loser_revivals = 0
        for case in cases:
            primary = G0._recall(
                case, repos[case["case_id"]], semantic_mode="test",
                runtime=runtime, alpha=FROZEN_ALPHA, tau=FROZEN_TAU)
            runtime_hard = OV.extract_runtime_hard_filter_codes(
                primary.get("trace"))

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
            revived = excluded_losers & set(primary["returned_ids"])
            if revived:
                conflict_loser_revivals += len(revived)

            case_diffs = OV.compare_traces(
                oracle_results, case, runtime_hard)
            if case_diffs:
                trace_diffs.extend(case_diffs)

            verdicts.append(CAL._e5base_verdict(
                case, primary, eligible))
    finally:
        from memory_engine import paths as engine_paths
        engine_paths.set_repo(REPO_ROOT)
        shutil.rmtree(root, ignore_errors=True)

    elapsed = time.perf_counter() - started

    # ---- 聚合指标（原始分子/分母 + v2 合同切片）----
    raw, counts, calibration_reasons = G0.raw_metrics(
        verdicts, baseline_top5=baseline_top5)
    contract = metrics_v2.compute_v2_slice(verdicts)
    if contract["returned_objects"] != counts["returned_objects"] or \
            contract["wrong_objects"] != counts["false_objects"] or \
            contract["golden_ids"] != counts["critical_total"]:
        raise E5BaseHoldoutError("METRIC_CONTRACT_COUNT_MISMATCH")

    # paraphrase（pp cases 全部在同一次运行中完成）
    pp_verdicts = [v for v in verdicts
                   if v["case_id"] in set(paraphrase_ids)]
    if len(pp_verdicts) != EXPECTED_PARAPHRASE_COUNT:
        raise E5BaseHoldoutError("PARAPHRASE_NOT_COMPLETED_IN_SAME_RUN")
    pp_correct_ids = [v["case_id"] for v in pp_verdicts
                      if paraphrase_correct(v)]
    pp_correct = len(pp_correct_ids)

    # NO MEMORY 最终合同口径：calibration（receipt）+ holdout（本轮）
    cal_counts = (receipt.get("selected") or {}).get("raw_counts") or {}
    cal_nm_ok = cal_counts.get("no_memory_correct", 0)
    cal_nm_total = cal_counts.get("no_memory_total", 0)
    holdout_nm_total = counts["no_memory_total"]
    holdout_nm_ok = counts["no_memory_correct"]
    if cal_nm_total + holdout_nm_total != len(no_memory_ids):
        raise E5BaseHoldoutError("NO_MEMORY_CONTRACT_PARTITION_MISMATCH")
    combined_nm_ok = cal_nm_ok + holdout_nm_ok
    combined_nm_total = cal_nm_total + holdout_nm_total

    # evidence 泄密探针（证据不含 secret 样值）
    result_probe = json.dumps(
        {"verdicts": verdicts, "oracle_results": oracle_results},
        ensure_ascii=False, sort_keys=True)
    secret_leaks = 1 if synthetic_secret in result_probe else 0

    leakage = leakage_breakdown(
        verdicts, cases_by_id, conflict_loser_revivals, secret_leaks)
    error_count = counts["error_count"]
    gates, all_passed = evaluate_gates(
        raw, pp_correct, combined_nm_ok, combined_nm_total, leakage,
        len(trace_diffs), error_count)

    if all_passed:
        result = "HOLDOUT_PASS_CANDIDATE"
    else:
        result = "HOLDOUT_FAIL_NO_GO"

    marker_payload = base_integrity["consumption_marker"]["content"]
    receipt_out = dict(base_integrity)
    receipt_out.update({
        "result": result,
        "authorization": (
            "产品所有者指令 2026-08-22：Gate 0-F 唯一一次 E5-base "
            "holdout（F0A 冻结 runner + F0B 唯一运行，两个独立提交，禁 "
            "amend）；alpha=1.00 / tau=0.90 正式选择固定；禁止第二次运行"
            " / replay / 重试 / 调参 / 修例外 / 重新分组；仅授权 Gate "
            "0-F，不启动 Gate 0-G/H/I、正式 Shadow 计数、真实 Binding、"
            "R4-1、Reflection、push、tag、release。"),
        "holdout_case_count": len(cases),
        "loaded_case_ids": [c["case_id"] for c in cases],
        "loaded_case_ids_sha256": G0._ordered_ids_sha(
            [c["case_id"] for c in cases]),
        "holdout_case_details_read": len(cases),
        "paraphrase_ids": list(paraphrase_ids),
        "paraphrase_completed_in_same_run": True,
        "raw_counts": counts,
        "raw_metrics": raw,
        "metric_contract_v2": contract,
        "calibration_gate_reason_codes_observed": calibration_reasons,
        "paraphrase": {
            "correct": pp_correct,
            "total": EXPECTED_PARAPHRASE_COUNT,
            "correct_case_ids": pp_correct_ids,
            "definition": "改写目标（eligible expected）命中 Top-5 且 "
                          "零 forbidden 命中且零引擎错误",
        },
        "no_memory": {
            "calibration_correct": cal_nm_ok,
            "calibration_total": cal_nm_total,
            "holdout_correct": holdout_nm_ok,
            "holdout_total": holdout_nm_total,
            "combined_correct": combined_nm_ok,
            "combined_total": combined_nm_total,
            "final_contract": "%d/%d" % (combined_nm_ok,
                                         combined_nm_total),
            "holdout_no_memory_case_ids": sorted(
                set(no_memory_ids) & {c["case_id"] for c in cases}),
        },
        "leakage": leakage,
        "gates": gates,
        "all_gates_passed": all_passed,
        "case_verdicts": verdicts,
        "trace_consistency": {
            "canonical_oracle": "memory_eval/e5_base/oracle_v3.py "
                                "(independent implementation)",
            "trace_mismatch_count": len(trace_diffs),
            "trace_mismatch_examples": trace_diffs[:20],
            "conflict_loser_revivals": conflict_loser_revivals,
            "conflict_loser_policy": "CONFLICT_LOSER 不得被向量路径复活；"
                                     "复活 = FAIL",
        },
        "eligible_expected_rule": "eligible_expected = frozen_expected ∩ "
                                  "canonical_survivors（oracle v3 口径）",
        "runtime": {
            "model": runtime.trace_model(),
            "passage_embedding_count": len(runtime.passage_ids),
            "query_embedding_count": runtime.query_embedding_count,
            "score_call_count": runtime.score_call_count,
            "scored_candidate_count": len(runtime.scored_candidate_ids),
            "elapsed_seconds": elapsed,
            "torch_version": torch.__version__,
            "python_version": "%d.%d.%d" % sys.version_info[:3],
            "platform": platform.platform(),
        },
        "evidence_secret_leak_count": secret_leaks,
        "protocol_deviations": [],
        "consumption_marker": dict(
            base_integrity["consumption_marker"],
            content=marker_payload),
    })
    return receipt_out


def _write_outputs(output_json, output_markdown, receipt):
    os.makedirs(os.path.dirname(os.path.abspath(output_json)),
                exist_ok=True)
    with open(output_json, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(receipt, fh, ensure_ascii=False, sort_keys=True,
                  indent=2)
        fh.write("\n")
    _write_markdown(output_markdown, receipt)


def _write_markdown(path, receipt):
    lines = [
        "# E5-base Holdout Receipt（%s）" % receipt.get("run_label", ""),
        "",
        "- Result: **%s**" % receipt["result"],
        "- Parameters (frozen): **alpha=%.2f / tau=%.2f**" % (
            receipt["parameters"]["alpha"], receipt["parameters"]["tau"]),
        "- Holdout cases executed: **%s**" % receipt.get(
            "holdout_case_count"),
        "- Holdout detail reads: **%s**" % receipt.get(
            "holdout_case_details_read"),
        "- Consumption marker: `%s`" % receipt["consumption_marker"][
            "path"],
        "- Marker SHA-256: `%s`" % receipt["consumption_marker"]["sha256"],
        "- Git HEAD: `%s`" % receipt["integrity"]["git_head"],
        "- Model manifest SHA-256: `%s`" % receipt["integrity"][
            "model_manifest_sha256"],
        "- Calibration receipt SHA-256: `%s`" % receipt["integrity"][
            "calibration_receipt_sha256"],
        "",
    ]
    if receipt.get("gates"):
        lines.extend(["## Gate verdicts", ""])
        for g in receipt["gates"]:
            lines.append("- %s = %s (rule %s): **%s**" % (
                g["gate"], g["value"], g["rule"],
                "PASS" if g["passed"] else "FAIL"))
        lines.append("")
        lines.append("- All gates passed: **%s**" % receipt[
            "all_gates_passed"])
        lines.append("")
        raw = receipt["raw_metrics"]
        counts = receipt["raw_counts"]
        lines.extend([
            "## Raw metrics (unrounded)", "",
            "- precision_at5_v2: %.12f (%d/%d)" % (
                raw["precision_at5_v2"], counts[
                    "precision_relevant_top5"],
                counts["precision_returned_top5"]),
            "- critical_memory_recall_v2: %.12f (%d/%d)" % (
                raw["critical_memory_recall_v2"], counts["critical_hits"],
                counts["critical_total"]),
            "- false_recall_rate_v2: %.12f (%d/%d)" % (
                raw["false_recall_rate_v2"], counts["false_objects"],
                counts["returned_objects"]),
            "- lexical_expected_preservation: %s (%d/%d)" % (
                raw["lexical_expected_preservation"],
                counts["lexical_expected_preserved"],
                counts["lexical_expected_baseline_total"]),
            "- prompt_token_p95: %s" % raw["prompt_token_p95"],
            "- NO MEMORY final contract: %s (cal %d/%d + holdout %d/%d)" % (
                receipt["no_memory"]["final_contract"],
                receipt["no_memory"]["calibration_correct"],
                receipt["no_memory"]["calibration_total"],
                receipt["no_memory"]["holdout_correct"],
                receipt["no_memory"]["holdout_total"]),
            "- paraphrase: %d/%d" % (receipt["paraphrase"][
                "correct"], receipt["paraphrase"]["total"]),
            "- trace mismatch: %d" % receipt["trace_consistency"][
                "trace_mismatch_count"],
            "- CONFLICT_LOSER revivals: %d" % receipt["trace_consistency"][
                "conflict_loser_revivals"],
            "- Protocol deviations: **none**", "",
        ])
    if receipt["result"] == "HOLDOUT_PASS_CANDIDATE":
        lines.extend([
            "## Statement scope", "",
            "本轮仅声明 **HOLDOUT PASS-CANDIDATE**。不启动 Gate 0-G/H/I、"
            "正式 Shadow 计数、真实 Binding、R4-1、Reflection，不 push / "
            "tag / release。唯一一次运行已消费（marker 已写入）。", "",
        ])
    elif receipt["result"] == "CONSUMED_INDETERMINATE":
        lines.extend([
            "## Indeterminate", "",
            "- error: %s" % receipt.get("error"),
            "- 唯一一次运行已消费；按协议记录 CONSUMED / INDETERMINATE，"
            "禁止自行重跑。", "",
        ])
    else:
        failed = [g for g in receipt.get("gates", [])
                  if not g["passed"]]
        lines.extend([
            "## NO-GO", "",
            "- failed gates: %s" % ", ".join(g["gate"] for g in failed),
            "- 唯一一次运行已消费；E5-base 本合同口径 **HOLDOUT FAIL / "
            "NO-GO**，禁止第二次运行。", "",
        ])
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="E5-base one-shot holdout acceptance "
                    "(alpha=1.00 / tau=0.90 frozen)")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--marker-path", required=True,
                        help="外置 one-shot consumption marker 路径"
                             "（仓库外；存在即拒绝运行）")
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-markdown", required=True)
    parser.add_argument("--calibration-index-dir", default=None,
                        help="校准主运行索引目录覆盖（默认取 receipt "
                             "记录值）")
    parser.add_argument("--run-label", default="one-shot")
    args = parser.parse_args(argv)

    receipt = run_holdout(
        args.model_dir, args.output_json, args.output_markdown,
        args.marker_path, calibration_index_dir=args.calibration_index_dir,
        label=args.run_label)

    print(json.dumps({
        "result": receipt["result"],
        "all_gates_passed": receipt.get("all_gates_passed"),
        "holdout_case_count": receipt.get("holdout_case_count"),
        "no_memory_final_contract": (
            receipt.get("no_memory") or {}).get("final_contract"),
        "paraphrase": (receipt.get("paraphrase") or {}).get("correct"),
        "consumption_marker_sha256": receipt["consumption_marker"][
            "sha256"],
    }, ensure_ascii=False, sort_keys=True))
    return 0 if receipt["result"] == "HOLDOUT_PASS_CANDIDATE" else 2


if __name__ == "__main__":
    raise SystemExit(main())
