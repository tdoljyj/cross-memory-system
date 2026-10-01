import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/model-program"))
import validate_m2_dataset_foundation as foundation
import validate_m2_dataset_split as domain


class DatasetSplitCandidateTests(unittest.TestCase):
    def setUp(self):
        self.bundle = foundation.load(foundation.FIXTURE)

    def reseal(self):
        manifest = self.bundle["manifest"]
        manifest["manifest_revision_sha256"] = foundation.digest({
            k: v for k, v in manifest.items() if k != "manifest_revision_sha256"})
        for report in self.bundle["selection_reports"]:
            report["manifest_revision_sha256"] = manifest["manifest_revision_sha256"]

    def reject(self, code=None):
        self.reseal()
        with self.assertRaises(foundation.FoundationError) as result:
            foundation.validate_bundle(self.bundle)
        if code:
            self.assertEqual(result.exception.code, "CLUED_MODEL_M2_" + code)

    def test_four_parents_six_purposes_and_exact_direction_reference(self):
        reference, definition = domain.validate_domain_candidate()
        self.assertEqual(len(definition["parent_boundaries"]), 4)
        self.assertEqual(len(definition["purposes"]), 6)
        self.assertEqual([row["parent_boundary"] for row in definition["purposes"][2:4]],
                         ["DEVELOPMENT", "DEVELOPMENT"])
        direction = reference["direction_acceptance"]
        self.assertEqual(direction["canonical_record_id"], "46d3e8e1-81f7-43af-aa46-11a37a1fd584")
        self.assertEqual(direction["canonical_receipt_id"], "fd2576dc-a0c2-4769-aab8-b8d88abd967a")
        self.assertEqual(direction["scope"], "FOUR_BOUNDARIES_AND_ISOLATED_DEVELOPMENT_DIRECTION_ONLY")
        self.assertIsNone(reference["domain_authority_receipt_ref"])
        result = foundation.validate_bundle(self.bundle)
        self.assertEqual(result["dataset_split_candidate_wiring"], "BOUND_LOCAL_CANDIDATE_ONLY")
        self.assertEqual(result["domain_adoption"], "NOT_ADOPTED")
        self.assertFalse(result["training_or_data_use_authorized"])

    def test_every_wrong_parent_and_purpose_identity_fails_after_manifest_reseal(self):
        original = copy.deepcopy(self.bundle)
        parents = ["TRAINING", "DEVELOPMENT", "QUALIFICATION", "FINAL_HOLDOUT"]
        purposes = [s["purpose_id"] for s in original["manifest"]["splits"]]
        for index, split in enumerate(original["manifest"]["splits"]):
            for field, values in [("parent_boundary", parents), ("purpose_id", purposes)]:
                for value in values:
                    if value == split[field]:
                        continue
                    self.bundle = copy.deepcopy(original)
                    self.bundle["manifest"]["splits"][index][field] = value
                    with self.subTest(index=index, field=field, value=value):
                        self.reject("SPLIT_PARENT_PURPOSE")

    def test_missing_unknown_and_additional_split_fields_are_closed(self):
        original = copy.deepcopy(self.bundle)
        required = ["schema_version", "candidate_definition_ref", "split_revision", "parent_boundary",
                    "purpose_id", "fixed_candidate_binding", "erasure_propagation_ref"]
        for field in required:
            self.bundle = copy.deepcopy(original)
            del self.bundle["manifest"]["splits"][0][field]
            with self.subTest(missing=field):
                self.reject("SCHEMA")
        for field, value in [("parent_boundary", "CALIBRATION"), ("purpose_id", "new-domain-enum"),
                             ("split_revision", ""), ("extra", True)]:
            self.bundle = copy.deepcopy(original)
            self.bundle["manifest"]["splits"][0][field] = value
            with self.subTest(field=field):
                self.reject("SCHEMA")

    def test_candidate_identity_and_root_binding_cannot_be_substituted(self):
        original = copy.deepcopy(self.bundle)
        for index in range(6):
            self.bundle = copy.deepcopy(original)
            self.bundle["manifest"]["splits"][index]["candidate_definition_ref"]["sha256"] = "0" * 64
            with self.subTest(index=index):
                self.reject("SPLIT_DEFINITION_BINDING")
        self.bundle = copy.deepcopy(original)
        self.bundle["manifest"]["candidate_domain_reference_sha256"] = "0" * 64
        self.reject("MANIFEST_DOMAIN_BINDING")

    def test_qualification_and_holdout_require_complete_fixed_candidate_bindings(self):
        original = copy.deepcopy(self.bundle)
        for index in (4, 5):
            self.bundle = copy.deepcopy(original)
            self.bundle["manifest"]["splits"][index]["fixed_candidate_binding"] = None
            with self.subTest(index=index, binding=None):
                self.reject("FIXED_CANDIDATE_BINDING")
            for field in original["manifest"]["splits"][index]["fixed_candidate_binding"]:
                self.bundle = copy.deepcopy(original)
                del self.bundle["manifest"]["splits"][index]["fixed_candidate_binding"][field]
                with self.subTest(index=index, missing=field):
                    self.reject("SCHEMA")
        for index in range(4):
            self.bundle = copy.deepcopy(original)
            self.bundle["manifest"]["splits"][index]["fixed_candidate_binding"] = copy.deepcopy(
                original["manifest"]["splits"][4]["fixed_candidate_binding"])
            with self.subTest(non_evaluation=index):
                self.reject("FIXED_CANDIDATE_BINDING")

    def test_qualification_consumer_and_exposure_are_restricted(self):
        self.bundle["manifest"]["splits"][4]["allowed_consumers"] = ["selector"]
        self.reject("FIXED_CANDIDATE_CONSUMER")
        self.bundle = foundation.load(foundation.FIXTURE)
        self.bundle["manifest"]["splits"][4]["exposure_records"].append(self.exposure())
        self.reject("FIXED_CANDIDATE_EXPOSED")

    @staticmethod
    def exposure():
        return {"event_id": "selection-exposure", "consumer_id": "selector",
                "purpose_description": "选型/策略验证", "used_for_selection": True,
                "source_revision": "fixture-rev-1"}

    def test_calibration_selection_exposure_is_rejected_at_split_and_sample(self):
        for collection in ("splits", "samples"):
            self.bundle = foundation.load(foundation.FIXTURE)
            self.bundle["manifest"][collection][2]["exposure_records"].append(self.exposure())
            with self.subTest(collection=collection):
                self.reject("CALIBRATION_SELECTION_EXPOSED")

    def test_qualification_cannot_relabel_exposed_or_old_samples(self):
        for kind in ("exposure", "PREVIOUSLY_EXPOSED_TEST_CASE", "UPSTREAM_FIXTURE_TEST_MARKER"):
            self.bundle = foundation.load(foundation.FIXTURE)
            sample = self.bundle["manifest"]["samples"][4]
            if kind == "exposure":
                sample["exposure_records"].append(self.exposure())
            else:
                sample["origin_kind"] = kind
            with self.subTest(kind=kind):
                self.reject("QUALIFICATION_RELABELED")

    def test_development_parent_does_not_merge_fit_and_selection_isolation(self):
        for group in ("source_session", "source_project", "semantic_near_duplicate_cluster"):
            self.bundle = foundation.load(foundation.FIXTURE)
            samples = self.bundle["manifest"]["samples"]
            samples[3]["isolation_groups"][group] = samples[2]["isolation_groups"][group]
            with self.subTest(group=group):
                self.reject("CROSS_SPLIT_GROUP")
        self.bundle = foundation.load(foundation.FIXTURE)
        samples = self.bundle["manifest"]["samples"]
        samples[3]["parent_sample_ids"] = [samples[2]["sample_id"]]
        self.reject("LINEAGE_CROSS_SPLIT")

    def test_direction_receipt_cannot_be_promoted_to_adoption_or_changed(self):
        original = foundation.load(domain.DOMAIN_REFERENCE)
        changes = [("domain_authority_receipt_ref", original["direction_acceptance"]["canonical_receipt_id"]),
                   ("domain_adoption_status", "ADOPTED"), ("formal_mapping_status", "RESOLVED"),
                   ("authority_effect", "ISSUED"), ("formal_dataset_split_ref", "invented-domain-object"),
                   ("training_or_data_use_authorized", True)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "domain.json"
            for field, value in changes:
                reference = copy.deepcopy(original)
                reference[field] = value
                path.write_text(json.dumps(reference), encoding="utf-8")
                with self.subTest(field=field), self.assertRaisesRegex(foundation.FoundationError,
                                                                      "DOMAIN_REFERENCE_IDENTITY"):
                    domain.validate_domain_candidate(path)
            for field, value in [("record_version", 2), ("record_version", True),
                                 ("canonical_record_id", "00000000-0000-0000-0000-000000000000"),
                                 ("quote_sha256", "0" * 64)]:
                reference = copy.deepcopy(original)
                reference["direction_acceptance"][field] = value
                path.write_text(json.dumps(reference), encoding="utf-8")
                with self.subTest(direction_field=field), self.assertRaises(foundation.FoundationError):
                    domain.validate_domain_candidate(path)

    def test_missing_changed_and_reformatted_candidate_artifacts_fail_identity(self):
        reference = foundation.load(domain.DOMAIN_REFERENCE)
        for ref in (reference["definition"], reference["instance_schema"]):
            path = ROOT / ref["path"]
            for failure in ("missing", "changed", "line_endings", "bom"):
                if failure == "missing":
                    side_effect, return_value = OSError("missing"), None
                else:
                    raw = path.read_bytes()
                    changed = {"changed": b"x" + raw[1:], "line_endings": raw.replace(b"\n", b"\r\n"),
                               "bom": b"\xef\xbb\xbf" + raw}[failure]
                    side_effect, return_value = None, changed
                with self.subTest(path=ref["path"], failure=failure):
                    with patch.object(Path, "read_bytes", side_effect=side_effect, return_value=return_value):
                        with self.assertRaises((foundation.FoundationError, OSError)):
                            domain.verify_artifact(ref, ref["path"])

    def test_cli_distinguishes_candidate_checks_from_missing_adoption(self):
        command = [sys.executable, str(ROOT / "scripts/model-program/validate_m2_dataset_split.py")]
        success = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(success.returncode, 0, success.stderr)
        value = json.loads(success.stdout)
        self.assertEqual(value["canonical_reference_live_check"], "NOT_RUN_OFFLINE")
        self.assertEqual(value["domain_adoption"], "NOT_ADOPTED")
        self.assertEqual(value["m2_verdict"], "NOT_ISSUED")
        blocked = subprocess.run(command + ["--require-adoption"], capture_output=True, text=True)
        self.assertEqual(blocked.returncode, 1)
        self.assertEqual(json.loads(blocked.stdout)["error"], "CLUED_MODEL_M2_DOMAIN_ADOPTION_REQUIRED")


if __name__ == "__main__":
    unittest.main()
