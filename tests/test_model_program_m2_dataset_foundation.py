import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/model-program/validate_m2_dataset_foundation.py"
sys.path.insert(0, str(SCRIPT.parent))
import validate_m2_dataset_foundation as m


class ModelProgramM2FoundationTests(unittest.TestCase):
    def setUp(self):
        self.bundle = m.load(m.FIXTURE)

    def reseal(self):
        manifest = self.bundle["manifest"]
        manifest["registry_sha256"] = m.digest(self.bundle["registry"]["sources"])
        manifest["manifest_revision_sha256"] = m.digest({
            k: v for k, v in manifest.items() if k != "manifest_revision_sha256"
        })
        for report in self.bundle["selection_reports"]:
            report["manifest_revision_sha256"] = manifest["manifest_revision_sha256"]

    def rejected(self, code, reseal=True):
        if reseal:
            self.reseal()
        with self.assertRaises(m.FoundationError) as result:
            m.validate_bundle(self.bundle)
        self.assertEqual(result.exception.code, "CLUED_MODEL_M2_" + code)

    def test_positive_is_candidate_only(self):
        result = m.validate_bundle(self.bundle)
        self.assertEqual(result["status"], "PASS_SYNTHETIC_OFFLINE_CHECKS_ONLY")
        self.assertEqual(result["dataset_split_authority_mapping"], "UNRESOLVED")
        self.assertEqual(result["m2_verdict"], "NOT_ISSUED")
        self.assertFalse(result["training_or_data_use_authorized"])
        self.assertFalse(result["real_holdout_secrecy_or_contamination_clearance"])

    def test_repeat_is_byte_deterministic_and_input_is_unchanged(self):
        before = copy.deepcopy(self.bundle)
        outputs = [json.dumps(m.validate_bundle(self.bundle), sort_keys=True) for _ in range(2)]
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(before, self.bundle)

    def test_cli_is_deterministic(self):
        a = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        b = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(a.returncode, 0, a.stderr)
        self.assertEqual(b.returncode, 0, b.stderr)
        self.assertEqual(a.stdout, b.stdout)

    def test_real_sources_default_blocked(self):
        for source_class in ["A", "B", "D", "E", "F"]:
            with self.subTest(source_class=source_class):
                self.bundle["registry"]["sources"][0]["source_class"] = source_class
                self.rejected("REAL_DATA_BLOCKED")

    def test_unresolved_or_withdrawn_license_is_rejected(self):
        for status in ["UNREVIEWED", "UNKNOWN", "WITHDRAWN"]:
            with self.subTest(status=status):
                self.bundle["registry"]["sources"][0]["license_review"] = status
                self.rejected("LICENSE_UNRESOLVED")

    def test_license_reference_cannot_be_substituted(self):
        self.bundle["registry"]["sources"][0]["license_ref"] = "pretend-approved-license"
        self.rejected("LICENSE_UNRESOLVED")

    def test_privacy_secrets_and_withdrawal_fail_closed(self):
        for key in ["contains_secrets", "contains_personal_data", "withdrawn"]:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle["registry"]["sources"][0][key] = True
                self.rejected("PRIVACY_OR_WITHDRAWAL")

    def test_raw_snapshot_digest(self):
        self.bundle["registry"]["sources"][0]["synthetic_inputs"]["input-0"] = "changed"
        self.rejected("SOURCE_DIGEST")

    def test_duplicate_source(self):
        second = copy.deepcopy(self.bundle["registry"]["sources"][0])
        second["source_revision"] = "different"
        self.bundle["registry"]["sources"].append(second)
        self.rejected("DUPLICATE_SOURCE")

    def test_manifest_tamper(self):
        self.bundle["manifest"]["dataset_revision"] = "different"
        self.rejected("MANIFEST_DIGEST", reseal=False)

    def test_registry_binding(self):
        self.bundle["registry"]["sources"][0]["filter_revision"] = "changed"
        self.rejected("REGISTRY_BINDING", reseal=False)

    def test_unknown_source_and_split(self):
        for key, code in [("source_id", "UNKNOWN_SOURCE"), ("split_id", "SPLIT_MEMBERSHIP")]:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle["manifest"]["samples"][0][key] = "unknown"
                self.rejected(code)

    def test_sample_revision_and_digest(self):
        for key, code in [("source_revision", "SOURCE_REVISION"), ("content_sha256", "SAMPLE_DIGEST")]:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle["manifest"]["samples"][0][key] = "0" * 64
                self.rejected(code)

    def test_membership_must_be_exact(self):
        self.bundle["manifest"]["splits"][0]["sample_ids"].append("phantom")
        self.rejected("SPLIT_MEMBERSHIP")

    def test_exact_duplicate_is_rejected_even_with_new_sample_id(self):
        samples = self.bundle["manifest"]["samples"]
        samples[1]["input_key"] = samples[0]["input_key"]
        samples[1]["content_sha256"] = samples[0]["content_sha256"]
        self.rejected("EXACT_DUPLICATE")

    def test_groups_cannot_cross_splits_even_if_rows_are_unique(self):
        for key in ["source_session", "source_project", "semantic_near_duplicate_cluster"]:
            with self.subTest(group_kind=key):
                self.bundle = m.load(m.FIXTURE)
                samples = self.bundle["manifest"]["samples"]
                samples[1]["isolation_groups"][key] = samples[0]["isolation_groups"][key]
                self.rejected("CROSS_SPLIT_GROUP")

    def test_holdout_blocks_all_training_and_selection_uses(self):
        for key in self.bundle["manifest"]["splits"][-1]["allowed_uses"]:
            with self.subTest(use=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle["manifest"]["splits"][-1]["allowed_uses"][key] = True
                self.rejected("HOLDOUT_USE")

    def exposure(self):
        return {"event_id": "exposure-1", "consumer_id": "developer",
                "purpose_description": "Observed in prior selection", "used_for_selection": True,
                "source_revision": "fixture-rev-1"}

    def test_split_exposure_cannot_be_laundered_into_holdout(self):
        self.bundle["manifest"]["splits"][-1]["exposure_records"].append(self.exposure())
        self.rejected("HOLDOUT_EXPOSED")

    def test_sample_exposure_and_old_fixture_cannot_be_laundered(self):
        for kind in ["exposure", "PREVIOUSLY_EXPOSED_TEST_CASE", "UPSTREAM_FIXTURE_TEST_MARKER"]:
            with self.subTest(kind=kind):
                self.bundle = m.load(m.FIXTURE)
                sample = self.bundle["manifest"]["samples"][-1]
                if kind == "exposure":
                    sample["exposure_records"].append(self.exposure())
                else:
                    sample["origin_kind"] = kind
                self.rejected("HOLDOUT_RELABELED")

    def test_holdout_consumer_is_restricted(self):
        self.bundle["manifest"]["splits"][-1]["allowed_consumers"].append("selector")
        self.rejected("HOLDOUT_CONSUMER")

    def test_calibration_fit_cannot_self_certify_selection(self):
        self.bundle["manifest"]["splits"][2]["allowed_uses"]["selection"] = True
        self.rejected("CALIBRATION_SELECTION_OVERLAP")

    def test_training_is_exclusive_of_all_other_uses(self):
        for key in ["prompt_or_architecture_tuning", "calibration_fit", "selection"]:
            with self.subTest(use=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle["manifest"]["splits"][0]["allowed_uses"][key] = True
                self.rejected("TRAINING_USE_OVERLAP")

    def test_calibration_fit_cannot_tune_prompts_or_architecture(self):
        self.bundle["manifest"]["splits"][2]["allowed_uses"]["prompt_or_architecture_tuning"] = True
        self.rejected("CALIBRATION_SELECTION_OVERLAP")

    def test_training_report_cannot_be_relabeled_as_selection_input(self):
        split = self.bundle["manifest"]["splits"][0]
        split["allowed_uses"]["selection"] = True
        report = self.bundle["selection_reports"][0]
        for key in ["split_id", "experiment_scope", "purpose_description"]:
            report[key] = split[key]
        self.rejected("TRAINING_USE_OVERLAP")

    def test_lineage_rejects_missing_parent_and_cross_split(self):
        for parent, code in [("missing", "LINEAGE_PARENT"), ("fixture-sample-1", "LINEAGE_CROSS_SPLIT")]:
            with self.subTest(parent=parent):
                self.bundle["manifest"]["samples"][0]["parent_sample_ids"] = [parent]
                self.rejected(code)

    def test_lineage_cycle(self):
        samples = self.bundle["manifest"]["samples"]
        splits = self.bundle["manifest"]["splits"]
        samples[1]["split_id"] = samples[0]["split_id"]
        splits[0]["sample_ids"].append(samples[1]["sample_id"])
        del splits[1]
        samples[0]["parent_sample_ids"] = [samples[1]["sample_id"]]
        samples[1]["parent_sample_ids"] = [samples[0]["sample_id"]]
        self.rejected("LINEAGE_CYCLE")

    def test_valid_deep_lineage_does_not_depend_on_python_recursion_limit(self):
        count = 1100
        source = self.bundle["registry"]["sources"][0]
        source["synthetic_inputs"] = {f"input-{i}": f"Unique synthetic test row {i}" for i in range(count)}
        source["raw_snapshot_sha256"] = m.digest(source["synthetic_inputs"])
        manifest = self.bundle["manifest"]
        template = manifest["samples"][0]
        manifest["samples"] = []
        manifest["splits"] = [manifest["splits"][0]]
        manifest["splits"][0]["sample_ids"] = [f"sample-{i}" for i in range(count)]
        self.bundle["selection_reports"] = []
        for i in range(count):
            sample = copy.deepcopy(template)
            sample.update(sample_id=f"sample-{i}", input_key=f"input-{i}",
                          raw_snapshot_sha256=source["raw_snapshot_sha256"],
                          content_sha256=m.digest(source["synthetic_inputs"][f"input-{i}"]),
                          parent_sample_ids=[f"sample-{i+1}"] if i+1 < count else [])
            manifest["samples"].append(sample)
        self.reseal()
        self.assertEqual(m.validate_bundle(self.bundle)["sample_count"], count)

    def test_selection_report_rejects_final_holdout_even_aggregate_only(self):
        report = self.bundle["selection_reports"][0]
        report["split_id"] = self.bundle["manifest"]["splits"][-1]["split_id"]
        self.rejected("HOLDOUT_OR_NON_SELECTION_REPORT")

    def test_report_revision_purpose_scope_and_consumer_are_bound(self):
        for key, code in [("manifest_revision_sha256", "REPORT_REVISION"),
                          ("purpose_description", "REPORT_SCOPE"),
                          ("experiment_scope", "REPORT_SCOPE"),
                          ("consumer_id", "REPORT_CONSUMER")]:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle["selection_reports"][0][key] = "0" * 64
                self.rejected(code, reseal=False)

    def test_schema_rejects_extra_fields_and_authority_claims(self):
        for change in ["extra", "authority_effect", "domain_mapping"]:
            with self.subTest(change=change):
                self.bundle = m.load(m.FIXTURE)
                if change == "domain_mapping":
                    self.bundle["manifest"]["dataset_split_authority_mapping"] = "ACCEPTED"
                else:
                    self.bundle["manifest"][change] = "ISSUED"
                self.rejected("SCHEMA")

    def test_duplicate_keys_nonfinite_and_malformed_json_fail_closed(self):
        for payload in ['{"a":1,"a":2}', '{"a":NaN}', '{broken']:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "bad.json"
                path.write_text(payload)
                result = subprocess.run([sys.executable, str(SCRIPT), "--fixture", str(path)],
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(json.loads(result.stdout)["status"], "FAIL_SYNTHETIC_OFFLINE_CHECKS")
                self.assertNotIn(payload, result.stdout)

    def test_missing_fixture_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(SCRIPT), "--fixture", str(Path(directory)/"missing")],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["error"], "CLUED_MODEL_M2_INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
