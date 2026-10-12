"""Real original scorer -> current saved replay/harness, public source examples."""
import builtins
import copy
import hashlib
import importlib.metadata
import json
from pathlib import Path
import types
import unittest

ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / "development/contracts/model-program/m2-core-saved-adapter/CoreSourceIdentity.e76.json"
SOURCE = ROOT / "tests/fixtures/model-stage-admission/core-adapter-e76"
CURRENT = ROOT / "scripts/model-program"


class PrivateSources:
    """Compile verified original file bytes at their own unchanged logical root."""
    def __init__(self):
        identity = json.loads(METADATA.read_bytes())
        assert identity["commit"] == "e76a7db7edc6b47b5a719e165f688621efa9580a"
        assert identity["authority_effect"] == "NONE"
        self.raw, self.paths, self.modules = {}, {}, {}
        for row in identity["files"]:
            path = SOURCE / row["path"]
            raw = path.read_bytes()
            assert len(raw) == row["bytes"]
            assert hashlib.sha256(raw).hexdigest() == row["sha256"]
            assert hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() == row["git_blob_sha1"]
            self.raw[row["path"]] = raw
            if row["path"].startswith("scripts/model-program/"):
                self.paths[path.stem] = path
        assert importlib.metadata.version("jsonschema") == "4.25.1"

    def module(self, name):
        if name not in self.modules:
            path = self.paths[name]
            self.modules[name] = self.load(path, name)
        return self.modules[name]

    def load(self, path, name, dependencies=None):
        module = types.ModuleType("private_core_adapter." + name)
        module.__file__, module.__package__ = str(path), ""
        dependencies = dependencies or {}
        namespace = dict(vars(builtins))
        def resolve(import_name, globals=None, locals=None, fromlist=(), level=0):
            if level == 0 and import_name in dependencies:
                return dependencies[import_name]
            if level == 0 and import_name in self.paths:
                return self.module(import_name)
            return builtins.__import__(import_name, globals, locals, fromlist, level)
        namespace["__import__"] = resolve
        module.__dict__["__builtins__"] = namespace
        relative = path.relative_to(SOURCE).as_posix() if path.is_relative_to(SOURCE) else None
        raw = self.raw[relative] if relative is not None else path.read_bytes()
        exec(compile(raw, str(path), "exec"), module.__dict__)
        return module


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                        ensure_ascii=False, allow_nan=False).encode()).hexdigest()


ADAPTER_CONTEXT = PrivateSources()
ADAPTER = ADAPTER_CONTEXT.load(CURRENT / "core_saved_adapter.py", "core_saved_adapter_under_test")
CoreSavedAdapter, ORIGINAL_SCORER_SHA256, SAVED_STATUS = (
    ADAPTER.CoreSavedAdapter, ADAPTER.ORIGINAL_SCORER_SHA256, ADAPTER.SAVED_STATUS)


class CoreAdapterSemantics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = PrivateSources()
        cls.old = cls.context.module("score_m2_core_saved_outputs")
        cls.runner = cls.context.load(CURRENT / "saved_report_runner.py", "current_runner")
        cls.harness = cls.context.load(CURRENT / "saved_harness.py", "current_harness",
                                       {"saved_report_runner": cls.runner})
        cls.source_raw = cls.context.raw["tests/fixtures/model-program-m2/core-development-candidate.json"]
        cls.contract_raw = cls.context.raw["development/contracts/model-program/m2/CoreSyntheticPilot.candidate.json"]
        cls.saved_raw = cls.context.raw["tests/fixtures/model-program-m2/core-saved-synthetic-outputs.json"]
        cls.contract = cls.old.strict_json(cls.context.raw["development/contracts/model-program/m2/CoreSavedOutput.candidate.json"])

    def adapter(self, saved_raw=None):
        return CoreSavedAdapter(self.old, self.source_raw, self.contract_raw,
            self.saved_raw if saved_raw is None else saved_raw, self.contract,
            source_sha256=ORIGINAL_SCORER_SHA256)

    def carrier(self, adapter):
        split_id = "SOURCE_EXAMPLE:original-core-development"
        snapshot = adapter.snapshot(split_id)
        policy = {"expected_request_ids": [r["id"] for r in snapshot],
                  "status_categories": {SAVED_STATUS: "SUCCEEDED"}, "comparison_kind": "CANDIDATE_REFERENCE_COMPARISON"}
        consumer = {"id": "SOURCE_EXAMPLE:original-core-reader", "uses_for_selection": False}
        split = {"split_id": split_id, "purpose_id": "development", "experiment_scope": "SOURCE_EXAMPLE",
                 "allowed_consumers": [consumer["id"]], "exposure_records": [], "final_holdout": False,
                 "sample_ids": policy["expected_request_ids"]}
        pins = {row["path"]: row["sha256"] for row in json.loads(METADATA.read_bytes())["files"]}
        adapter_sha = hashlib.sha256((CURRENT / "core_saved_adapter.py").read_bytes()).hexdigest()
        sources = {role: {"ref": "SOURCE_EXAMPLE:core_saved_adapter.py:" + role, "sha256": adapter_sha}
                   for role in ("scorer", "projector", "metrics")}
        for role in ("normalization", "renderer"):
            path = "scripts/model-program/validate_m2_offline_pipeline.py"
            sources[role] = {"ref": "e76:" + path, "sha256": pins[path]}
        metadata = [{"id": r["id"], "input_sha256": r["input_sha256"], "terminal_status": r["terminal_status"],
            "usage": None, "split_id": split_id, "raw_output_sha256": hashlib.sha256(r["raw_output"]).hexdigest()}
                    for r in snapshot]
        binding = {"snapshot_sha256": digest(metadata), "policy": policy, "policy_sha256": digest(policy),
            "split_sha256": digest(split), "sources": sources, "source_locks": copy.deepcopy(sources),
            "provider_ref": "SOURCE_EXAMPLE:deterministic-writer", "model_ref": "SOURCE_EXAMPLE:NO_MODEL_INFERENCE",
            "model_revision_ref": "e76a7db7edc6b47b5a719e165f688621efa9580a", "profile_ref": None,
            "gold_ref": None, "threshold_ref": None, "evidence_kind": "SPECIFICATION_EXAMPLE",
            "dataset_revision_sha256": adapter.legacy_report["dataset_revision"]["sha256"],
            "evaluation_revision_sha256": adapter.legacy_report["evaluation_revision"]["sha256"],
            "original_core_source": {"sha256": ORIGINAL_SCORER_SHA256, "comparison_kind": "CANDIDATE_REFERENCE_COMPARISON"}}
        return {"snapshot": snapshot, "binding": binding, "split": split, "consumer": consumer,
                **adapter.callbacks()}

    def test_original_24_replay_preserves_candidate_flags_not_gold(self):
        adapter = self.adapter()
        report = self.runner.run_saved(**self.carrier(adapter))["report"]
        legacy = report["metrics"]["legacy_report"]
        self.assertEqual(legacy, adapter.legacy_report)
        self.assertEqual((legacy["sample_count"], legacy["schema_valid_count"], legacy["reference_valid_count"], legacy["correct_count"]),
                         (24, 24, 24, 24))
        self.assertEqual(legacy["saved_outputs_raw_sha256"], "e9591e5329e000b1f57c3e5842c1d6a48100939a6d26da1e698fb7ab8d748aa7")
        self.assertEqual(report["metrics"]["quality"]["unknown_count"], 24)
        self.assertIsNone(report["metrics"]["quality"]["success_fraction_all_requests"])
        self.assertEqual(report["metrics"]["runtime_measurements"], "NOT_MEASURED")
        self.assertEqual(report["qualification"], "NOT_ISSUED")
        self.assertTrue(all(r["usage"] is None for r in report["requests"]))

    def test_real_original_scorer_and_current_harness_connect(self):
        adapter = self.adapter()
        run = self.carrier(adapter)
        slot = {"slot_id": "SOURCE_EXAMPLE:core24", "suite_ref": "e76:CoreSavedOutput.candidate.json",
            "workflow_ref": None, "comparison_group": None,
            "controls": {role: None for role in self.harness.CONTROL_ROLES},
            "binding": copy.deepcopy(run["binding"]), "split": copy.deepcopy(run["split"]),
            "consumer": copy.deepcopy(run["consumer"]),
            "input_requests": [{k: r[k] for k in ("id", "input_sha256", "split_id")} for r in run["snapshot"]]}
        result = self.harness.run_harness([slot], {slot["slot_id"]: run}, self.runner.run_saved, consumer=run["consumer"])
        self.assertEqual(result["slot_status_counts"], {"REPLAYED_CANDIDATE": 1})
        self.assertEqual(result["formal_suite_workflow_coverage"], "NOT_ESTABLISHED")
        self.assertFalse(result["all_reference_inputs_present"])

    def test_raw_bytes_drift_rejected_by_seal_before_scoring(self):
        run = self.carrier(self.adapter())
        run["snapshot"][0]["raw_output"] += b" "
        with self.assertRaises(ValueError):
            self.runner.run_saved(**run)

    def test_duplicate_and_omitted_outputs_keep_original_rejection(self):
        for operation in ("duplicate", "missing"):
            saved = self.old.strict_json(self.saved_raw)
            if operation == "duplicate":
                saved["outputs"][1] = copy.deepcopy(saved["outputs"][0])
            else:
                saved["outputs"].pop()
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                self.adapter(json.dumps(saved, ensure_ascii=False).encode())

    def test_typed_and_reference_drift_keep_original_score_semantics(self):
        for kind in ("type", "reference"):
            saved = self.old.strict_json(self.saved_raw)
            target = next(r for r in saved["outputs"] if "card_chain" in r["sample_id"])
            answer = self.old.strict_json(target["output_text"].encode())
            if kind == "type":
                answer["execute"] = 1
            else:
                answer["anchor_message_ids"] = ["SOURCE_EXAMPLE:unknown-reference"]
            target["output_text"] = json.dumps(answer, ensure_ascii=False)
            adapter = self.adapter(json.dumps(saved, ensure_ascii=False).encode())
            with self.subTest(kind=kind):
                report = self.runner.run_saved(**self.carrier(adapter))["report"]["metrics"]["legacy_report"]
                self.assertEqual(report["correct_count"], 23)
                self.assertEqual(report["schema_valid_count"], 23 if kind == "type" else 24)
                self.assertEqual(report["reference_valid_count"], 23)
                self.assertIsNone(report["formal_gold_ref"])

    def test_actual_runtime_status_or_usage_cannot_be_invented(self):
        adapter = self.adapter()
        for field, value in (("terminal_status", "succeeded"), ("usage", {"input_tokens": 0}),
                             ("usage", {}), ("raw_output", None)):
            rows = adapter.snapshot("SOURCE_EXAMPLE:split")
            rows[0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                adapter.scorer(rows, self.carrier(adapter)["binding"], self.carrier(adapter)["split"])
        for omitted in ("terminal_status", "usage"):
            rows = adapter.snapshot("SOURCE_EXAMPLE:split")
            rows[0].pop(omitted)
            with self.subTest(omitted=omitted), self.assertRaises(ValueError):
                adapter.scorer(rows, self.carrier(adapter)["binding"], self.carrier(adapter)["split"])

    def test_live_gold_profile_or_revision_upgrade_is_rejected(self):
        adapter = self.adapter()
        for field, value in (("evidence_kind", "LIVE_MODEL_MEASUREMENT"), ("gold_ref", "SOURCE_EXAMPLE:fake-gold"),
                             ("profile_ref", "SOURCE_EXAMPLE:fake-profile"), ("dataset_revision_sha256", "0" * 64)):
            run = self.carrier(adapter)
            run["binding"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.runner.run_saved(**run)

    def test_source_and_input_bytes_drift_not_blessed_by_rehash(self):
        with self.assertRaises(ValueError):
            CoreSavedAdapter(self.old, self.source_raw + b" ", self.contract_raw, self.saved_raw,
                             self.contract, source_sha256=ORIGINAL_SCORER_SHA256)
        adapter = self.adapter()
        rows = adapter.snapshot("SOURCE_EXAMPLE:split")
        rows[0]["input_sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            adapter.scorer(rows, self.carrier(adapter)["binding"], self.carrier(adapter)["split"])


if __name__ == "__main__":
    unittest.main()
