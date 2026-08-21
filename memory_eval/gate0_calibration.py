# -*- coding: utf-8 -*-
"""Gate 0-E sealed calibration runner.

The parameter-selection process parses only the 53-case calibration bundle.
The full frozen manifest, corpus, runner and fixture source are read as opaque
bytes for integrity hashing; holdout queries and verdicts are never parsed.
"""

import argparse
import hashlib
import json
import os
import shutil
import struct
import subprocess
import tempfile
import time

from memory_engine import paths as engine_paths
from memory_engine import recall_engine
from memory_engine import recall_trace as RT
from memory_engine import schema as S
from memory_engine import vector_index as VI
from memory_eval import metrics as metrics_v2
from memory_eval import schema as eval_schema


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_DIR = os.path.join(REPO_ROOT, "memory_eval", "gate0_inputs")
LOCK_PATH = os.path.join(INPUT_DIR, "calibration-lock.json")
CASES_PATH = os.path.join(INPUT_DIR, "calibration-cases.json")
FIXTURES_PATH = os.path.join(INPUT_DIR, "calibration-fixtures.json")
EXPECTED_CALIBRATION_IDS_SHA256 = (
    "1b0ea9cba921bc700bb98714743a26c6be4ec570896a07a50803665347442e09")
EXPECTED_CASE_COUNT = 53
EXPECTED_GRID_COUNT = 60
CALIBRATION_SCHEMA_VERSION = "r4-gate0-calibration-v1"


class CalibrationError(RuntimeError):
    pass


def _sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha_json(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _ordered_ids_sha(values):
    return hashlib.sha256("\n".join(values).encode("utf-8")).hexdigest()


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def verify_and_load_inputs(repo_root=REPO_ROOT):
    """Verify frozen bytes, then parse calibration-only bundles."""
    lock_path = os.path.join(
        repo_root, "memory_eval", "gate0_inputs", "calibration-lock.json")
    lock = _load_json(lock_path)
    if lock.get("lock_type") != "gate0-calibration-input-lock":
        raise CalibrationError("CALIBRATION_LOCK_TYPE_MISMATCH")
    if lock.get("calibration_count") != EXPECTED_CASE_COUNT:
        raise CalibrationError("CALIBRATION_COUNT_MISMATCH")
    if lock.get("holdout_count") != 58:
        raise CalibrationError("HOLDOUT_COUNT_COMMITMENT_MISMATCH")
    if lock.get("calibration_ids_sha256") != \
            EXPECTED_CALIBRATION_IDS_SHA256:
        raise CalibrationError("CALIBRATION_SPLIT_MISMATCH")
    if len(lock.get("alpha_grid") or []) * len(lock.get("tau_grid") or []) != \
            EXPECTED_GRID_COUNT:
        raise CalibrationError("CALIBRATION_GRID_MISMATCH")
    for rel, expected in sorted((lock.get("source_files") or {}).items()):
        path = os.path.join(repo_root, *rel.split("/"))
        if _sha_file(path) != expected:
            raise CalibrationError("FROZEN_SOURCE_DRIFT: " + rel)
    for rel, expected in sorted((lock.get("sealed_inputs") or {}).items()):
        path = os.path.join(repo_root, *rel.split("/"))
        if _sha_file(path) != expected:
            raise CalibrationError("SEALED_INPUT_DRIFT: " + rel)

    cases_payload = _load_json(os.path.join(
        repo_root, "memory_eval", "gate0_inputs", "calibration-cases.json"))
    fixtures_payload = _load_json(os.path.join(
        repo_root, "memory_eval", "gate0_inputs", "calibration-fixtures.json"))
    cases = cases_payload.get("cases") or []
    fixtures = fixtures_payload.get("fixtures") or {}
    ids = [case.get("case_id") for case in cases]
    if len(cases) != EXPECTED_CASE_COUNT or len(set(ids)) != len(ids):
        raise CalibrationError("CALIBRATION_CASE_SET_INVALID")
    if _ordered_ids_sha(ids) != EXPECTED_CALIBRATION_IDS_SHA256:
        raise CalibrationError("CALIBRATION_CASE_ORDER_MISMATCH")
    if _sha_json(cases) != lock.get("case_contract_sha256"):
        raise CalibrationError("CALIBRATION_CASE_CONTRACT_MISMATCH")
    used = sorted({fid for case in cases for fid in case.get("fixtures", [])})
    if set(used) != set(fixtures):
        raise CalibrationError("CALIBRATION_FIXTURE_SET_MISMATCH")
    if _ordered_ids_sha(used) != lock.get("fixture_ids_sha256"):
        raise CalibrationError("CALIBRATION_FIXTURE_ORDER_MISMATCH")
    for pos, case in enumerate(cases):
        ok, errors = eval_schema.validate_case(case, pos)
        if not ok:
            raise CalibrationError("INVALID_CALIBRATION_CASE: " + "; ".join(errors))
    return lock, cases, fixtures


def _runtime_fixture_copy(fixtures):
    # The repository bundle keeps a placeholder. Runtime materialization uses
    # the fixed synthetic marker so the real secret filter is exercised.
    marker = "ghp_" + "A" * 24
    out = {}
    for fid, obj in fixtures.items():
        clone = json.loads(json.dumps(obj, ensure_ascii=False))
        if isinstance(clone.get("content"), str):
            clone["content"] = clone["content"].replace(
                "__FAKE_TOKEN__", marker)
        out[fid] = clone
    return out, marker


def _materialize_cases(cases, fixtures):
    root = tempfile.mkdtemp(prefix="gate0-calibration-")
    repos = {}
    guards = os.path.join(REPO_ROOT, "guards.json")
    for case in cases:
        repo = os.path.join(root, case["case_id"])
        memory = os.path.join(repo, "memory")
        objects = os.path.join(memory, "objects")
        os.makedirs(objects)
        os.makedirs(os.path.join(memory, "audit"))
        index = {
            "schema_version": 1,
            "files": ["画像.md"],
            "recall": {"L1": [], "L2": [], "L3": [],
                       "L4": [], "L5": [], "L6": []},
        }
        with open(os.path.join(memory, "index.json"), "w",
                  encoding="utf-8", newline="\n") as fh:
            json.dump(index, fh, ensure_ascii=False, sort_keys=True)
        with open(os.path.join(memory, "画像.md"), "w", encoding="utf-8",
                  newline="\n") as fh:
            fh.write("# Gate 0 synthetic calibration fixture\n")
        if os.path.isfile(guards):
            shutil.copyfile(guards, os.path.join(repo, "guards.json"))
        for fid in case["fixtures"]:
            with open(os.path.join(objects, fid + ".json"), "w",
                      encoding="utf-8", newline="\n") as fh:
                json.dump(fixtures[fid], fh, ensure_ascii=False,
                          sort_keys=True, indent=2)
                fh.write("\n")
        repos[case["case_id"]] = repo
    return root, repos


class CalibrationVectorRuntime(object):
    """In-memory E5 table. No query, content or vector is persisted."""

    def __init__(self, embedder, cases, fixtures):
        self.embedder = embedder
        self.manifest_digest = embedder.manifest_digest
        model = (embedder.manifest or {}).get("model") or {}
        self._model = {
            "id": model.get("id"),
            "immutable_revision": model.get("immutable_revision"),
            "manifest_digest": self.manifest_digest,
        }
        eligible = set()
        for case in cases:
            when = S.parse_ts(case.get("now"))
            for fid in case["fixtures"]:
                if not VI._initial_exclusion_reasons(fixtures[fid], when=when):
                    eligible.add(fid)
        self.passage_ids = sorted(eligible)
        passages = [VI.serialize_passage(fixtures[fid])
                    for fid in self.passage_ids]
        tensor = embedder.embed_passages(passages)
        self._passages = {
            fid: [float(x) for x in tensor[pos].tolist()]
            for pos, fid in enumerate(self.passage_ids)
        }
        self._queries = {}
        self.query_embedding_count = 0
        self.score_call_count = 0
        self.scored_candidate_ids = set()
        digest = hashlib.sha256()
        digest.update(CALIBRATION_SCHEMA_VERSION.encode("ascii"))
        for fid in self.passage_ids:
            digest.update(fid.encode("ascii"))
            digest.update(struct.pack("<%df" % len(self._passages[fid]),
                                      *self._passages[fid]))
        self.vector_table_digest = digest.hexdigest()

    def trace_model(self):
        return dict(self._model)

    def score(self, query, candidate_ids, canonical_objects, valid_at=None):
        self.score_call_count += 1
        wanted = set(candidate_ids)
        if not wanted <= set(self._passages):
            raise CalibrationError("CALIBRATION_VECTOR_MISSING")
        key = hashlib.sha256(query.encode("utf-8")).hexdigest()
        if key not in self._queries:
            row = self.embedder.embed_query(query)[0].tolist()
            self._queries[key] = [float(x) for x in row]
            self.query_embedding_count += 1
        qvec = self._queries[key]
        self.scored_candidate_ids |= wanted
        return {
            oid: float(sum(a * b for a, b in zip(qvec, self._passages[oid])))
            for oid in wanted
        }


def _recall(case, repo, semantic_mode="off", runtime=None,
            alpha=None, tau=None):
    engine_paths.set_repo(repo)
    try:
        scope, project_id = eval_schema.scope_to_engine(case.get("scope"))
        started = time.perf_counter()
        result = recall_engine.recall(
            query=case["query"], tier=case.get("tier", "T2"),
            layers=case.get("layers"), scope=scope,
            project_id=project_id,
            include_history=case.get("include_history", False),
            categories=case.get("categories"), tags=case.get("tags"),
            entities=case.get("entities"), limit=case.get("limit", 10),
            valid_at=S.parse_ts(case.get("now")), explain=True,
            semantic_mode=semantic_mode, vector_runtime=runtime,
            alpha=alpha, tau=tau)
        latency = (time.perf_counter() - started) * 1000.0
        trace = result.trace or {}
        return {
            "returned_ids": [obj["id"] for obj in result.objects],
            "trace": trace,
            "tokens": RT.packed_token_estimate(
                result.markdown_plan, result.objects, result.constraints),
            "latency_ms": latency,
            "semantic_status": result.semantic_status,
            "error": None,
        }
    except Exception as exc:  # fail closed into an auditable failed grid row
        return {
            "returned_ids": [], "trace": {}, "tokens": 0,
            "latency_ms": 0.0, "semantic_status": None,
            "error": "ENGINE_EXCEPTION:" + type(exc).__name__,
        }
    finally:
        engine_paths.set_repo(REPO_ROOT)


def _verdict(case, primary):
    returned = primary["returned_ids"]
    expected = set(case["expected_relevant_ids"])
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
        "expected_relevant_ids": list(case["expected_relevant_ids"]),
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


def _p95(values):
    if not values:
        return None
    ordered = sorted(values)
    pos = max(0, min(len(ordered) - 1,
                     int(round(0.95 * (len(ordered) - 1)))))
    return ordered[pos]


def raw_metrics(verdicts, baseline_top5=None):
    with_return = [v for v in verdicts if v["returned_ids"]]
    rel_num = sum(len(set(v["returned_ids"][:5]) &
                      set(v["expected_relevant_ids"])) for v in with_return)
    rel_den = sum(len(v["returned_ids"][:5]) for v in with_return)
    wrong_num = sum(len((set(v["returned_ids"]) -
                         set(v["expected_relevant_ids"])) |
                        (set(v["returned_ids"]) & set(v["forbidden_ids"])))
                    for v in with_return)
    wrong_den = sum(len(v["returned_ids"]) for v in with_return)
    crit_num = sum(len(set(v["returned_ids"]) &
                       set(v["expected_relevant_ids"])) for v in verdicts)
    crit_den = sum(len(set(v["expected_relevant_ids"])) for v in verdicts)
    no_mem = [v for v in verdicts if v["no_memory_expected"]]
    no_mem_ok = sum(not v["no_memory_violated"] for v in no_mem)
    forbidden_hits = sum(len(v["forbidden_hits"]) for v in verdicts)
    error_count = sum(bool(v["error"]) for v in verdicts)
    preserved_num = preserved_den = 0
    if baseline_top5 is not None:
        for v in verdicts:
            required = set(baseline_top5.get(v["case_id"], [])) & \
                set(v["expected_relevant_ids"])
            preserved_den += len(required)
            preserved_num += len(required & set(v["returned_ids"][:5]))
    tokens = [v["tokens"] for v in verdicts if v["returned_ids"]]
    raw = {
        "precision_at5_v2": rel_num / rel_den if rel_den else None,
        "critical_memory_recall_v2": crit_num / crit_den if crit_den else None,
        "false_recall_rate_v2": wrong_num / wrong_den if wrong_den else None,
        "no_memory_correctness": no_mem_ok / len(no_mem) if no_mem else None,
        "lexical_expected_preservation": (
            preserved_num / preserved_den if preserved_den else 1.0),
        "prompt_token_p95": _p95(tokens),
    }
    counts = {
        "precision_relevant_top5": rel_num,
        "precision_returned_top5": rel_den,
        "critical_hits": crit_num,
        "critical_total": crit_den,
        "false_objects": wrong_num,
        "returned_objects": wrong_den,
        "no_memory_correct": no_mem_ok,
        "no_memory_total": len(no_mem),
        "forbidden_hits": forbidden_hits,
        "error_count": error_count,
        "lexical_expected_preserved": preserved_num,
        "lexical_expected_baseline_total": preserved_den,
    }
    reasons = []
    checks = [
        (raw["precision_at5_v2"] is not None and
         raw["precision_at5_v2"] >= 0.90, "PRECISION_LT_0_90"),
        (raw["critical_memory_recall_v2"] is not None and
         raw["critical_memory_recall_v2"] >= 0.95, "CRITICAL_LT_0_95"),
        (raw["false_recall_rate_v2"] is not None and
         raw["false_recall_rate_v2"] <= 0.02, "FALSE_RECALL_GT_0_02"),
        (no_mem_ok == len(no_mem), "NO_MEMORY_NOT_ALL_CORRECT"),
        (forbidden_hits == 0, "FORBIDDEN_LEAKAGE"),
        (error_count == 0, "ENGINE_ERROR"),
        (raw["lexical_expected_preservation"] == 1.0,
         "LEXICAL_BASELINE_EXPECTED_LOST"),
        (raw["prompt_token_p95"] is not None and
         raw["prompt_token_p95"] <= 650, "TOKEN_P95_GT_650"),
    ]
    for passed, code in checks:
        if not passed:
            reasons.append(code)
    return raw, counts, reasons


def _selection_key(row):
    return (
        -row["raw_metrics"]["critical_memory_recall_v2"],
        -row["raw_metrics"]["precision_at5_v2"],
        row["raw_metrics"]["false_recall_rate_v2"],
        row["raw_metrics"]["prompt_token_p95"],
        -row["tau"], -row["alpha"])


def select_winner(rows):
    eligible = [row for row in rows if row.get("qualifying")]
    if not eligible:
        return None
    return min(eligible, key=_selection_key)


def run_calibration(model_dir, output_json, output_markdown):
    lock, cases, fixture_bundle = verify_and_load_inputs()
    fixtures, synthetic_secret = _runtime_fixture_copy(fixture_bundle)
    root, repos = _materialize_cases(cases, fixtures)
    try:
        from memory_engine.embedding_adapter import E5Embedder
        embedder = E5Embedder(model_dir, device="cpu")
        runtime = CalibrationVectorRuntime(embedder, cases, fixtures)

        baseline_top5 = {}
        for case in cases:
            primary = _recall(case, repos[case["case_id"]])
            baseline_top5[case["case_id"]] = primary["returned_ids"][:5]

        rows = []
        started = time.perf_counter()
        for alpha in lock["alpha_grid"]:
            for tau in lock["tau_grid"]:
                verdicts = []
                for case in cases:
                    primary = _recall(
                        case, repos[case["case_id"]], semantic_mode="test",
                        runtime=runtime, alpha=alpha, tau=tau)
                    verdicts.append(_verdict(case, primary))
                raw, counts, reasons = raw_metrics(
                    verdicts, baseline_top5=baseline_top5)
                contract = metrics_v2.compute_v2_slice(verdicts)
                if contract["returned_objects"] != counts["returned_objects"] or \
                        contract["wrong_objects"] != counts["false_objects"] or \
                        contract["golden_ids"] != counts["critical_total"]:
                    raise CalibrationError("METRIC_CONTRACT_COUNT_MISMATCH")
                rows.append({
                    "alpha": alpha, "tau": tau,
                    "raw_metrics": raw, "raw_counts": counts,
                    "metric_contract_v2_rounded": contract,
                    "qualifying": not reasons,
                    "elimination_reasons": reasons,
                    "_verdicts": verdicts,
                })
        elapsed = time.perf_counter() - started
        winner = select_winner(rows)

        diagnostic = winner or min(rows, key=_selection_key)
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

        result_probe = json.dumps(
            {"rows": rows, "diagnostic_verdicts": diagnostic_verdicts,
             "selected_verdicts": selected_verdicts},
            ensure_ascii=False, sort_keys=True)
        secret_leaks = 1 if synthetic_secret in result_probe else 0
        if secret_leaks and selected_public:
            selected_public["qualifying"] = False
            selected_public.setdefault("elimination_reasons", []).append(
                "SECRET_IN_EVIDENCE")
            winner = None

        code_path = os.path.abspath(__file__)
        try:
            head = subprocess.run(
                ["git", "-C", REPO_ROOT, "rev-parse", "HEAD"],
                capture_output=True, text=True, check=True).stdout.strip()
        except Exception:
            head = None
        index_evidence = os.path.join(
            REPO_ROOT, "docs", "r4-gate0", "evidence",
            "index-manifest.redacted.json")
        receipt = {
            "schema_version": CALIBRATION_SCHEMA_VERSION,
            "result": "PASS" if winner else "NO-GO",
            "calibration_case_count": len(cases),
            "loaded_case_ids": [case["case_id"] for case in cases],
            "loaded_case_ids_sha256": _ordered_ids_sha(
                [case["case_id"] for case in cases]),
            "holdout_detail_reads": 0,
            "grid_count": len(rows),
            "grid": {"alpha": lock["alpha_grid"], "tau": lock["tau_grid"]},
            "qualifying_count": sum(row["qualifying"] for row in rows),
            "selected": selected_public,
            "best_observed_nonqualifying": (
                diagnostic_public if winner is None else None),
            "grid_results": rows,
            "selected_case_verdicts": selected_verdicts,
            "diagnostic_case_verdicts": diagnostic_verdicts,
            "integrity": {
                "git_head": head,
                "calibration_code_sha256": _sha_file(code_path),
                "calibration_lock_sha256": _sha_file(LOCK_PATH),
                "frozen_sources": lock["source_files"],
                "sealed_inputs": lock["sealed_inputs"],
                "model_manifest_sha256": runtime.manifest_digest,
                "canonical_index_evidence_sha256": _sha_file(index_evidence),
                "calibration_vector_table_sha256": runtime.vector_table_digest,
            },
            "runtime": {
                "model": runtime.trace_model(),
                "passage_embedding_count": len(runtime.passage_ids),
                "query_embedding_count": runtime.query_embedding_count,
                "score_call_count": runtime.score_call_count,
                "scored_candidate_count": len(runtime.scored_candidate_ids),
                "grid_elapsed_seconds": elapsed,
            },
            "evidence_secret_leak_count": secret_leaks,
            "protocol_deviations": [],
        }
        os.makedirs(os.path.dirname(os.path.abspath(output_json)), exist_ok=True)
        with open(output_json, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(receipt, fh, ensure_ascii=False, sort_keys=True, indent=2)
            fh.write("\n")
        lines = [
            "# Gate 0-E Calibration Receipt", "",
            "- Result: **%s**" % receipt["result"],
            "- Calibration cases loaded: **53**",
            "- Holdout detail reads: **0**",
            "- Grid combinations: **60**",
            "- Qualifying combinations: **%d**" % receipt["qualifying_count"],
            "- Model manifest SHA-256: `%s`" % runtime.manifest_digest,
            "- Calibration vector table SHA-256: `%s`" %
            runtime.vector_table_digest,
            "- Protocol deviations: **none**", "",
        ]
        if selected_public:
            lines.extend([
                "## Frozen selection", "",
                "- alpha: **%.2f**" % selected_public["alpha"],
                "- tau: **%.2f**" % selected_public["tau"],
                "- precision_at5_v2: %.12f" %
                selected_public["raw_metrics"]["precision_at5_v2"],
                "- critical_memory_recall_v2: %.12f" %
                selected_public["raw_metrics"]["critical_memory_recall_v2"],
                "- false_recall_rate_v2: %.12f" %
                selected_public["raw_metrics"]["false_recall_rate_v2"],
                "- prompt token P95: %s" %
                selected_public["raw_metrics"]["prompt_token_p95"], "",
            ])
        else:
            failed_cases = [v for v in diagnostic_verdicts
                            if v["missed"] or v["extra"] or
                            v["forbidden_hits"] or v["error"]]
            lines.extend([
                "## Best observed non-qualifying point", "",
                "- alpha: **%.2f**" % diagnostic_public["alpha"],
                "- tau: **%.2f**" % diagnostic_public["tau"],
                "- elimination reasons: `%s`" % ", ".join(
                    diagnostic_public["elimination_reasons"]),
                "- discrepant cases: **%s**" % ", ".join(
                    v["case_id"] for v in failed_cases), "",
                "## Stop condition", "",
                "No grid combination met every calibration hard gate. The E5 "
                "candidate is **NO-GO** and Gate 0-F must not run.", "",
            ])
        with open(output_markdown, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(lines))
        return receipt
    finally:
        engine_paths.set_repo(REPO_ROOT)
        shutil.rmtree(root, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Gate 0-E sealed calibration")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--output-markdown", required=True)
    args = parser.parse_args(argv)
    receipt = run_calibration(
        args.model_dir, args.output_json, args.output_markdown)
    print(json.dumps({
        "result": receipt["result"],
        "qualifying_count": receipt["qualifying_count"],
        "selected": receipt["selected"],
    }, ensure_ascii=False, sort_keys=True))
    return 0 if receipt["result"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
