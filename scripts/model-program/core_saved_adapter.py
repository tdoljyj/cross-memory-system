"""Thin candidate bridge for the exact original Core saved-output scorer.

CoreSavedAdapter receives a caller-verified, privately loaded e76 scorer module
and its ORIGINAL source/contract/saved bytes. It calls score_saved, not run or
generate_fixture, and preserves its full schema/reference/exact-match guards.
The old validator's internal deterministic reference reconstruction remains
unchanged; no fixture or Dataset is created or written by this adapter.

The original 24 author-visible DEVELOPMENT outputs have no runtime status,
actual usage, formal Gold, probabilities or independent qualification. Their
candidate correct flags stay in legacy_core_score/legacy_report, explicitly
CANDIDATE_REFERENCE_COMPARISON; true_label/correct in the numeric projection
remain None. SAVED_CANDIDATE_OUTPUT means a saved source artifact only.

snapshot(split_id), scorer, projector, metrics and renderer can be supplied to
the existing run_saved/harness. Caller supplies the original refs and a local
SPECIFICATION_EXAMPLE carrier; these methods create no Domain/Port/authority.
"""
import copy
import hashlib


ORIGINAL_SCORER_SHA256 = "7a0a77880f6627325fbbac9390d8d880450703e8a2c7453bc95858d5e1f71ed3"
COMPARISON_KIND = "CANDIDATE_REFERENCE_COMPARISON"
SAVED_STATUS = "SAVED_CANDIDATE_OUTPUT"


def require(condition, code):
    if not condition:
        raise ValueError("CORE_SAVED_ADAPTER_" + code)


class CoreSavedAdapter:
    def __init__(self, original, source_raw, source_contract_raw, saved_raw, contract, *, source_sha256):
        require(source_sha256 == ORIGINAL_SCORER_SHA256, "ORIGINAL_SCORER_IDENTITY")
        require(all(type(raw) is bytes for raw in (source_raw, source_contract_raw, saved_raw)), "RAW_BYTES")
        self.original = original
        self.source_raw, self.source_contract_raw, self.saved_raw = source_raw, source_contract_raw, saved_raw
        self.contract = copy.deepcopy(contract)
        # Full original validator/scorer: no new parser, reference or quality rule.
        self.legacy_report = original.score_saved(source_raw, source_contract_raw, saved_raw, self.contract)
        require(self.legacy_report["authority_effect"] == "NONE" and
                self.legacy_report["m2_verdict"] == "NOT_ISSUED" and
                self.legacy_report["model_inference_performed"] is False and
                self.legacy_report["formal_gold_ref"] is None, "ORIGINAL_CANDIDATE_SCOPE")
        saved = original.strict_json(saved_raw)
        self.outputs = {row["sample_id"]: row["output_text"].encode("utf-8", errors="strict")
                        for row in saved["outputs"]}
        self.scores = {row["sample_id"]: row for row in self.legacy_report["scores"]}

    def snapshot(self, split_id):
        require(type(split_id) is str and bool(split_id), "CALLER_SPLIT_ID")
        return [{"id": key, "input_sha256": self.scores[key]["input_sha256"],
                 "raw_output": self.outputs[key], "terminal_status": SAVED_STATUS,
                 "usage": None, "split_id": split_id} for key in sorted(self.scores)]

    def _snapshot(self, rows):
        require(type(rows) is list and len(rows) == len(self.scores) and
                all(type(row) is dict for row in rows), "EXACT_SAVED_COVERAGE")
        ids = [row.get("id") for row in rows]
        require(all(type(key) is str for key in ids) and len(set(ids)) == len(ids) and
                set(ids) == set(self.scores), "DUPLICATE_OR_MISSING_ID")
        for row in rows:
            score = self.scores[row["id"]]
            require(row.get("input_sha256") == score["input_sha256"], "INPUT_IDENTITY")
            raw = row.get("raw_output")
            require(type(raw) is bytes and raw == self.outputs[row["id"]] and
                    hashlib.sha256(raw).hexdigest() == score["output_text_raw_utf8_sha256"], "ORIGINAL_OUTPUT_BYTES")
            require(row.get("terminal_status") == SAVED_STATUS and "usage" in row and row["usage"] is None,
                    "SOURCE_EXAMPLE_HAS_NO_RUNTIME_MEASUREMENT")

    def scorer(self, snapshot, binding, split):
        self._snapshot(snapshot)
        require(binding.get("evidence_kind") == "SPECIFICATION_EXAMPLE" and
                binding.get("gold_ref") is None and binding.get("profile_ref") is None and
                binding.get("threshold_ref") is None, "NO_FORMAL_OR_LIVE_UPGRADE")
        require(split.get("purpose_id") == "development" and split.get("final_holdout") is False,
                "ORIGINAL_DEVELOPMENT_SCOPE")
        for key in ("dataset_revision", "evaluation_revision"):
            require(binding.get(key + "_sha256") == self.legacy_report[key]["sha256"], "ORIGINAL_REVISION")
        # Call the actual original scorer on every replay, not a cached replacement.
        report = self.original.score_saved(self.source_raw, self.source_contract_raw, self.saved_raw,
                                           copy.deepcopy(self.contract))
        require(self.original.digest(report) == self.original.digest(self.legacy_report), "ORIGINAL_REPORT_DRIFT")
        result = copy.deepcopy(snapshot)
        for row in result:
            row["legacy_core_score"] = copy.deepcopy(self.scores[row["id"]])
            row["legacy_report_sha256"] = report["score_sha256"]
            row["comparison_kind"] = COMPARISON_KIND
        return result

    def projector(self, scored, policy):
        self._snapshot(scored)
        require(set(policy.get("expected_request_ids", [])) == set(self.scores) and
                policy.get("status_categories", {}).get(SAVED_STATUS) == "SUCCEEDED", "LOCAL_PROJECTION_POLICY")
        result = []
        for saved in scored:
            legacy = saved.get("legacy_core_score")
            require(legacy == self.scores[saved["id"]] and saved.get("comparison_kind") == COMPARISON_KIND,
                    "LEGACY_SCORE_IDENTITY")
            result.append({"id": saved["id"], "status": saved["terminal_status"], "usage": None,
                "schema_valid": legacy["schema_valid"], "reference_valid": legacy["reference_valid"],
                "true_label": None, "predicted_label": None, "correct": None, "probabilities": None,
                "auto_accepted": False, "latency_ms": None, "tokens_input": None, "tokens_output": None,
                "cost": None, "currency": None, "comparison_kind": COMPARISON_KIND,
                "legacy_core_score": copy.deepcopy(legacy),
                "legacy_report_sha256": saved["legacy_report_sha256"]})
        return result

    def metrics(self, rows, policy):
        require(type(rows) is list and len(rows) == len(self.scores), "METRIC_COVERAGE")
        ids = [row.get("id") for row in rows]
        require(len(set(ids)) == len(ids) and set(ids) == set(self.scores), "METRIC_IDENTITY")
        for row in rows:
            require(row.get("legacy_core_score") == self.scores[row["id"]] and
                    row.get("legacy_report_sha256") == self.legacy_report["score_sha256"] and
                    row.get("comparison_kind") == COMPARISON_KIND and
                    all(row.get(k) is None for k in ("true_label", "predicted_label", "correct", "probabilities",
                                                   "latency_ms", "tokens_input", "tokens_output", "cost", "currency")) and
                    row.get("auto_accepted") is False, "NO_GOLD_OR_MEASUREMENT_INJECTION")
        return {"status": "CANDIDATE_REFERENCE_COMPARISON_ONLY", "authority_effect": "NONE",
            "gate_verdict": "NOT_ISSUED", "comparison_kind": COMPARISON_KIND,
            "legacy_report": copy.deepcopy(self.legacy_report), "total_request_count": len(rows),
            "quality": {"status": "EXTERNAL_INPUT_REQUIRED", "gold_known_count": 0,
                        "unknown_count": len(rows), "success_fraction_all_requests": None},
            "probability": {"status": "NOT_APPLICABLE"},
            "runtime_measurements": "NOT_MEASURED", "qualification": "NOT_ISSUED"}

    def renderer(self, report):
        # Exact original renderer policy; only UTF-8 encoding is adapted for run_saved.
        return self.original.offline.render(report).encode("utf-8", errors="strict")

    def callbacks(self):
        """Plain functions survive the harness's data deepcopy without copying modules.

        The caller still verifies the closed source context and callback purity.
        This does not make mutable context or Python callable identity authoritative.
        """
        def scorer(snapshot, binding, split):
            return self.scorer(snapshot, binding, split)
        def projector(scored, policy):
            return self.projector(scored, policy)
        def metrics(rows, policy):
            return self.metrics(rows, policy)
        def renderer(report):
            return self.renderer(report)
        return {"scorer": scorer, "projector": projector, "metrics": metrics, "renderer": renderer}
