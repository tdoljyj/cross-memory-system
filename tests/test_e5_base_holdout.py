# -*- coding: utf-8 -*-
"""Gate 0-F F0A one-shot holdout runner contract tests.

全部使用合成 fixture；不读取、不解析任何真实 holdout query /
expected / forbidden / paraphrase case 内容。
（run_holdout 的 preflight 失败路径测试只触碰已提交公开证据与
锁文件，且在 marker 写入前失败 = 未消费。）
"""

import json
import os
import sys
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from memory_eval.e5_base import holdout as H  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def _raises(exc_type, fn, *args, **kwargs):
    try:
        fn(*args, **kwargs)
    except exc_type:
        return True
    except Exception as exc:  # noqa: BLE001
        raise AssertionError(
            "wrong exception: %s (%s)" % (type(exc).__name__, exc))
    raise AssertionError("expected %s was not raised" % exc_type.__name__)


# ---------------------------------------------------------------
# 1. 参数冻结：硬编码 alpha=1.00 / tau=0.90，无任何调参面
# ---------------------------------------------------------------

def test_parameters_hardcoded_no_tuning_surface():
    check(H.FROZEN_ALPHA == 1.0, "alpha must be frozen at 1.00")
    check(H.FROZEN_TAU == 0.90, "tau must be frozen at 0.90")
    with open(H.__file__, "r", encoding="utf-8") as fh:
        source = fh.read()
    for forbidden in ('"--alpha"', '"--tau"', "alpha_grid", "tau_grid",
                      "select_winner", "grid_results"):
        check(forbidden not in source,
              "holdout runner must not expose tuning surface: "
              + forbidden)
    check("argparse.ArgumentParser" in source, "CLI present")


# ---------------------------------------------------------------
# 2. runner 源码零 holdout 细节（细节一律运行时从冻结语料装载）
# ---------------------------------------------------------------

def test_runner_source_contains_no_holdout_detail():
    with open(H.__file__, "r", encoding="utf-8") as fh:
        source = fh.read()
    for marker in ("pp-0", "cs-004", "ps-016", "ep-001", "sa-001",
                   "mem_fx0g", "mem_fx0h", "mem_fx0e", "nm-002"):
        check(marker not in source,
              "runner source must not contain holdout detail: " + marker)


# ---------------------------------------------------------------
# 3. 外置原子 one-shot consumption marker
# ---------------------------------------------------------------

def test_marker_atomic_one_shot():
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sub", "marker.json")
        payload = {"schema_version": H.MARKER_SCHEMA_VERSION,
                   "k": "v"}
        sha = H.write_consumption_marker(path, payload)
        check(len(sha) == 64, "marker sha256 hex")
        check(os.path.isfile(path), "marker written")
        with open(path, "r", encoding="utf-8") as fh:
            on_disk = json.load(fh)
        check(on_disk == payload, "marker content round-trip")
        # 第二次写入必须拒绝（one-shot 已消费）
        _raises(H.HoldoutConsumedError,
                H.write_consumption_marker, path, payload)
        _raises(H.HoldoutConsumedError, H.assert_not_consumed, path)
        # 已消费的 run_holdout 入口在 preflight 之后同样拒绝
        check(H.assert_not_consumed(os.path.join(tmp, "absent.json"))
              is None, "absent marker must not raise")


def test_marker_payload_commits_frozen_run_identity():
    payload = H.build_marker_payload(
        "deadbeef" * 5, ["a", "b"], "m" * 64, "r" * 64, "c" * 64)
    check(payload["parameters_frozen"] == {"alpha": 1.0, "tau": 0.9},
          "marker pins frozen parameters")
    check(payload["holdout_case_count"] == 2, "marker pins case count")
    check(payload["schema_version"] == H.MARKER_SCHEMA_VERSION,
          "marker schema")
    check("one-shot" in payload["policy"], "marker states one-shot policy")


# ---------------------------------------------------------------
# 4. preflight 在 marker 写入前失败 → 不算消费（可修复环境后重试）
# ---------------------------------------------------------------

def test_preflight_failure_leaves_no_marker():
    with tempfile.TemporaryDirectory() as tmp:
        marker = os.path.join(tmp, "marker.json")
        bogus_model_dir = os.path.join(tmp, "no-model")
        os.makedirs(bogus_model_dir)
        _raises(H.E5BaseHoldoutError, H.run_holdout,
                bogus_model_dir, os.path.join(tmp, "out.json"),
                os.path.join(tmp, "out.md"), marker)
        check(not os.path.exists(marker),
              "preflight failure must not write the consumption marker")


def test_consumed_marker_blocks_run():
    with tempfile.TemporaryDirectory() as tmp:
        marker = os.path.join(tmp, "marker.json")
        H.write_consumption_marker(marker, {"consumed": True})
        bogus_model_dir = os.path.join(tmp, "no-model")
        _raises(H.HoldoutConsumedError, H.run_holdout,
                bogus_model_dir, os.path.join(tmp, "out.json"),
                os.path.join(tmp, "out.md"), marker)


# ---------------------------------------------------------------
# 5. 合成 fixture：split 装载 / case 精确选取
# ---------------------------------------------------------------

def _syn_cases(n, prefix="syn"):
    return [{"case_id": "%s-%03d" % (prefix, i + 1)}
            for i in range(n)]


def test_select_holdout_cases_synthetic():
    corpus = _syn_cases(6)
    ids = ["syn-001", "syn-003", "syn-006"]
    cases = H.select_holdout_cases(corpus, ids, ["syn-003"])
    check([c["case_id"] for c in cases] == ids,
          "selection follows manifest ID order exactly")
    # 语料缺失 holdout ID → 拒绝
    _raises(H.E5BaseHoldoutError, H.select_holdout_cases,
            corpus, ["syn-001", "syn-999"], [])
    # 语料重复 ID → 拒绝
    dup = corpus + [{"case_id": "syn-001"}]
    _raises(H.E5BaseHoldoutError, H.select_holdout_cases,
            dup, ids, [])
    # paraphrase case 缺失 → 拒绝（必须同一次运行完成）
    _raises(H.E5BaseHoldoutError, H.select_holdout_cases,
            corpus, ids, ["syn-002"])
    # validator 拒绝非法 case
    _raises(H.E5BaseHoldoutError, H.select_holdout_cases,
            [{"case_id": "syn-001"}], ["syn-001"], [],
            validator=lambda c, i: (False, ["synthetic-invalid"]))


def test_frozen_split_contract_on_public_manifest():
    # 只读取已提交公开 manifest 的 ID 清单（非 case 内容）
    manifest, holdout_ids, no_memory_ids, paraphrase_ids = \
        H.load_frozen_split()
    check(len(holdout_ids) == H.EXPECTED_HOLDOUT_COUNT,
          "manifest must commit exactly 58 holdout IDs")
    check(len(no_memory_ids) == H.EXPECTED_TOTAL_NO_MEMORY,
          "manifest must commit 41 NO MEMORY cases")
    check(len(paraphrase_ids) == H.EXPECTED_PARAPHRASE_COUNT,
          "manifest must commit 12 paraphrase cases")


# ---------------------------------------------------------------
# 6. 合成 fixture：calibration receipt 契约校验
# ---------------------------------------------------------------

def _syn_receipt(**over):
    receipt = {
        "schema_version": H.CAL.CALIBRATION_SCHEMA_VERSION,
        "result": "PASS",
        "holdout_detail_reads": 0,
        "protocol_deviations": [],
        "selected": {
            "alpha": 1.0, "tau": 0.9, "qualifying": True,
            "raw_counts": {"no_memory_correct": 26,
                           "no_memory_total": 26},
        },
        "integrity": {
            "candidate_lock_sha256": "l" * 64,
            "lock_digests_measured": {"k": "v"},
            "calibration_code_sha256": "a" * 64,
            "oracle_v3_code_sha256": "b" * 64,
            "embedder_code_sha256": "c" * 64,
            "e5_base_runner_gate0_sha256": "d" * 64,
            "frozen_sources": {"memory_eval/corpus.py": "e" * 64},
        },
    }
    receipt.update(over)
    return receipt


def _syn_measured():
    return {
        "candidate_lock_sha256": "l" * 64,
        "lock_digests": {"k": "v"},
        "code_digests": {
            "calibration_code_sha256": "a" * 64,
            "oracle_v3_code_sha256": "b" * 64,
            "embedder_code_sha256": "c" * 64,
            "e5_base_runner_gate0_sha256": "d" * 64,
        },
        "frozen_sources": {"memory_eval/corpus.py": "e" * 64},
    }


def test_receipt_contract_accepts_synthetic_anchor():
    H.check_calibration_receipt_contract(
        _syn_receipt(), _syn_measured())


def test_receipt_contract_rejects_tampering():
    def reject(**over):
        _raises(H.E5BaseHoldoutError,
                H.check_calibration_receipt_contract,
                _syn_receipt(**over), _syn_measured())
    reject(result="NO-GO")
    reject(holdout_detail_reads=1)
    reject(protocol_deviations=["x"])
    reject(schema_version="bogus")
    receipt = _syn_receipt()
    receipt["selected"]["alpha"] = 0.75
    _raises(H.E5BaseHoldoutError,
            H.check_calibration_receipt_contract, receipt, _syn_measured())
    receipt = _syn_receipt()
    receipt["selected"]["tau"] = 0.85
    _raises(H.E5BaseHoldoutError,
            H.check_calibration_receipt_contract, receipt, _syn_measured())
    receipt = _syn_receipt()
    receipt["selected"]["raw_counts"]["no_memory_correct"] = 25
    _raises(H.E5BaseHoldoutError,
            H.check_calibration_receipt_contract, receipt, _syn_measured())
    # 实测漂移（代码 / 语料 / 锁）同样拒绝
    measured = _syn_measured()
    measured["code_digests"]["embedder_code_sha256"] = "f" * 64
    _raises(H.E5BaseHoldoutError,
            H.check_calibration_receipt_contract,
            _syn_receipt(), measured)
    measured = _syn_measured()
    measured["frozen_sources"]["memory_eval/corpus.py"] = "f" * 64
    _raises(H.E5BaseHoldoutError,
            H.check_calibration_receipt_contract,
            _syn_receipt(), measured)
    measured = _syn_measured()
    measured["candidate_lock_sha256"] = "f" * 64
    _raises(H.E5BaseHoldoutError,
            H.check_calibration_receipt_contract,
            _syn_receipt(), measured)


# ---------------------------------------------------------------
# 7. 合成 fixture：门槛裁决（含边界值）
# ---------------------------------------------------------------

def _perfect_raw():
    return {
        "precision_at5_v2": 0.90,
        "critical_memory_recall_v2": 0.95,
        "false_recall_rate_v2": 0.02,
        "lexical_expected_preservation": 1.0,
        "prompt_token_p95": 650,
    }


def _zero_leakage():
    return {"scope_leakage": 0, "superseded_leakage": 0,
            "conflict_loser_revival": 0, "secret_leakage": 0,
            "forbidden_leakage_total": 0}


def test_gates_pass_at_exact_thresholds():
    gates, passed = H.evaluate_gates(
        _perfect_raw(), 11, 41, 41, _zero_leakage(), 0, 0)
    check(passed, "exact threshold values must pass: %r"
          % [g for g in gates if not g["passed"]])
    by_name = {g["gate"]: g for g in gates}
    check(by_name["paraphrase_correct"]["value"] == "11/12",
          "paraphrase gate reports numerator/denominator")
    check(by_name["no_memory_final_contract"]["value"] == "41/41",
          "NO MEMORY gate reports final contract")


def test_gates_fail_below_thresholds():
    def run_gates(raw, pp=11, nm=(41, 41), leak=None, trace=0, err=0):
        gates, passed = H.evaluate_gates(
            raw, pp, nm[0], nm[1], leak or _zero_leakage(), trace, err)
        return {g["gate"]: g for g in gates}, passed

    raw = _perfect_raw(); raw["precision_at5_v2"] = 0.8999
    by_name, _ = run_gates(raw)
    check(not by_name["precision_at5_v2"]["passed"],
          "precision boundary")

    raw = _perfect_raw(); raw["critical_memory_recall_v2"] = 0.9499
    by_name, _ = run_gates(raw)
    check(not by_name["critical_memory_recall_v2"]["passed"],
          "recall boundary")

    raw = _perfect_raw(); raw["false_recall_rate_v2"] = 0.0201
    by_name, _ = run_gates(raw)
    check(not by_name["false_recall_rate_v2"]["passed"],
          "false recall boundary")

    raw = _perfect_raw(); raw["prompt_token_p95"] = 651
    by_name, _ = run_gates(raw)
    check(not by_name["prompt_token_p95"]["passed"], "token boundary")

    raw = _perfect_raw(); raw["lexical_expected_preservation"] = 0.99
    by_name, _ = run_gates(raw)
    check(not by_name["lexical_expected_preservation"]["passed"],
          "lexical boundary")

    by_name, _ = run_gates(_perfect_raw(), pp=10)
    check(not by_name["paraphrase_correct"]["passed"],
          "paraphrase 10/12 fails")

    by_name, _ = run_gates(_perfect_raw(), nm=(40, 41))
    check(not by_name["no_memory_final_contract"]["passed"],
          "NO MEMORY 40/41 fails")

    for key in ("scope_leakage", "superseded_leakage",
                "conflict_loser_revival", "secret_leakage",
                "forbidden_leakage_total"):
        leak = _zero_leakage(); leak[key] = 1
        by_name, _ = run_gates(_perfect_raw(), leak=leak)
        check(not by_name[key]["passed"],
              "leakage %s must fail" % key)

    by_name, _ = run_gates(_perfect_raw(), trace=1)
    check(not by_name["trace_mismatch"]["passed"],
          "trace mismatch fails")
    by_name, _ = run_gates(_perfect_raw(), err=1)
    check(not by_name["error_count"]["passed"], "error count fails")


# ---------------------------------------------------------------
# 8. 合成 fixture：paraphrase 正确性与 leakage 归因
# ---------------------------------------------------------------

def test_paraphrase_correctness_definition():
    ok = {"eligible_expected_ids": ["t1"],
          "returned_ids": ["t1", "x"], "forbidden_hits": [],
          "error": None}
    check(H.paraphrase_correct(ok), "target in top5 = correct")
    miss = {"eligible_expected_ids": ["t1"], "returned_ids": ["x"],
            "forbidden_hits": [], "error": None}
    check(not H.paraphrase_correct(miss), "target missed = incorrect")
    deep = {"eligible_expected_ids": ["t1"],
            "returned_ids": ["a", "b", "c", "d", "e", "t1"],
            "forbidden_hits": [], "error": None}
    check(not H.paraphrase_correct(deep), "target outside top5")
    leak = {"eligible_expected_ids": ["t1"], "returned_ids": ["t1"],
            "forbidden_hits": ["f"], "error": None}
    check(not H.paraphrase_correct(leak), "forbidden hit = incorrect")
    err = {"eligible_expected_ids": ["t1"], "returned_ids": ["t1"],
           "forbidden_hits": [], "error": "ENGINE_EXCEPTION:X"}
    check(not H.paraphrase_correct(err), "engine error = incorrect")
    empty = {"eligible_expected_ids": [], "returned_ids": [],
             "forbidden_hits": [], "error": None}
    check(not H.paraphrase_correct(empty),
          "no eligible target = incorrect")


def test_leakage_breakdown_attribution():
    verdicts = [
        {"case_id": "s1", "forbidden_hits": ["f1"]},
        {"case_id": "s2", "forbidden_hits": []},
        {"case_id": "s3", "forbidden_hits": ["f2", "f3"]},
    ]
    cases = {
        "s1": {"critical_assertions": ["no_scope_leak"]},
        "s2": {"critical_assertions": ["no_superseded_leak"]},
        "s3": {"critical_assertions": ["no_secret_leak",
                                       "no_scope_leak"]},
    }
    leak = H.leakage_breakdown(verdicts, cases, 2, 1)
    check(leak["scope_leakage"] == 3, "scope attribution")
    check(leak["superseded_leakage"] == 0, "superseded attribution")
    check(leak["conflict_loser_revival"] == 2, "conflict attribution")
    check(leak["secret_leakage"] == 2 + 1, "secret = hits + evidence")
    check(leak["forbidden_leakage_total"] == 3, "total forbidden")


# ---------------------------------------------------------------
# 9. 消费后异常 → CONSUMED / INDETERMINATE（禁止自行重跑）
# ---------------------------------------------------------------

def test_indeterminate_receipt_written_after_consumption():
    import tempfile as tf

    real_execute = H._execute_holdout

    def boom(*args, **kwargs):
        raise RuntimeError("synthetic post-consumption crash")

    H._execute_holdout = boom
    try:
        with tf.TemporaryDirectory() as tmp:
            marker = os.path.join(tmp, "marker.json")
            out_json = os.path.join(tmp, "out.json")
            out_md = os.path.join(tmp, "out.md")
            # 用缺失模型目录无法到达 marker（preflight 失败），
            # 因此这里使用真实模型目录（由环境提供）才能走到消费阶段。
            model_dir = os.environ.get("E5_BASE_MODEL_DIR", "")
            if not model_dir or not os.path.isdir(model_dir):
                return  # 环境未提供模型目录时跳过（不构成失败）
            try:
                H.run_holdout(model_dir, out_json, out_md, marker)
            except RuntimeError:
                pass
            else:
                raise AssertionError("crash must propagate")
            check(os.path.isfile(marker), "marker written before crash")
            with open(out_json, "r", encoding="utf-8") as fh:
                receipt = json.load(fh)
            check(receipt["result"] == "CONSUMED_INDETERMINATE",
                  "post-consumption crash = CONSUMED / INDETERMINATE")
            check(receipt["consumption_marker"]["sha256"],
                  "receipt records marker digest")
            # 第二次运行必须拒绝
            _raises(H.HoldoutConsumedError, H.run_holdout,
                    model_dir, out_json, out_md, marker)
    finally:
        H._execute_holdout = real_execute


def main():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL %s: %s" % (fn.__name__, exc))
    print("%d/%d passed" % (len(tests) - failed, len(tests)))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
