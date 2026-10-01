import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/model-program"
sys.path.insert(0, str(SCRIPTS))
import validate_m2_split_mapping as mapping
import validate_m2_dataset_foundation as foundation


class SplitMappingTests(unittest.TestCase):
    def test_candidate_is_closed_and_has_no_domain_authority(self):
        rows = mapping.validate_candidate(foundation.load(mapping.CANDIDATE))
        self.assertEqual(len(rows), 6)
        self.assertTrue(all(row["dataset_split_ref"] is None for row in rows.values()))

    def test_candidate_mutations_cannot_create_authority_or_change_policy(self):
        original = foundation.load(mapping.CANDIDATE)
        for key, value in [("authority_effect", "ISSUED"), ("domain_mapping_status", "ACCEPTED"),
                           ("official_definition_status", "VERIFIED"), ("extra", True)]:
            candidate = copy.deepcopy(original)
            candidate[key] = value
            with self.subTest(key=key), self.assertRaises(foundation.FoundationError):
                mapping.validate_candidate(candidate)
        for mutate in [lambda x: x["mappings"].pop(),
                       lambda x: x["mappings"].append(x["mappings"][0]),
                       lambda x: x["mappings"][4].update(selection_report_allowed=True),
                       lambda x: x["mappings"][0].update(final_holdout=0),
                       lambda x: x["mappings"][1].update(selection_report_allowed=1),
                       lambda x: x["plan_source"].update(size_bytes=356825.0),
                       lambda x: x["mappings"][0].update(dataset_split_ref="invented-training"),
                       lambda x: x["plan_source"].update(sha256="0" * 64),
                       lambda x: x["plan_source"]["ranges"][0].update(start_line=1)]:
            candidate = copy.deepcopy(original)
            mutate(candidate)
            with self.assertRaises(foundation.FoundationError):
                mapping.validate_candidate(candidate)

    def test_each_use_bit_and_holdout_flag_are_bound_to_purpose(self):
        for index in range(6):
            for key in ["weight_learning", "prompt_or_architecture_tuning", "calibration_fit",
                        "selection", "final_holdout"]:
                bundle = foundation.load(foundation.FIXTURE)
                split = bundle["manifest"]["splits"][index]
                if key == "final_holdout":
                    split[key] = not split[key]
                else:
                    split["allowed_uses"][key] = not split["allowed_uses"][key]
                self.reseal(bundle)
                with self.subTest(index=index, key=key), self.assertRaises(foundation.FoundationError):
                    foundation.validate_bundle(bundle)

    def test_unknown_purpose_and_qualification_selection_are_rejected(self):
        for index, purpose in [(1, "arbitrary-use"), (1, "资格")]:
            bundle = foundation.load(foundation.FIXTURE)
            bundle["manifest"]["splits"][index]["purpose_description"] = purpose
            self.reseal(bundle)
            with self.assertRaises(foundation.FoundationError):
                foundation.validate_bundle(bundle)

    def test_only_development_and_selection_reports_are_accepted(self):
        for index in range(6):
            bundle = foundation.load(foundation.FIXTURE)
            split = bundle["manifest"]["splits"][index]
            report = bundle["selection_reports"][0]
            report.update(split_id=split["split_id"], purpose_description=split["purpose_description"],
                          experiment_scope=split["experiment_scope"], consumer_id=split["allowed_consumers"][0])
            with self.subTest(index=index):
                if index in (1, 3):
                    foundation.validate_bundle(bundle)
                else:
                    with self.assertRaises(foundation.FoundationError):
                        foundation.validate_bundle(bundle)

    @staticmethod
    def reseal(bundle):
        manifest = bundle["manifest"]
        manifest["manifest_revision_sha256"] = foundation.digest({
            k: v for k, v in manifest.items() if k != "manifest_revision_sha256"})
        for report in bundle["selection_reports"]:
            report["manifest_revision_sha256"] = manifest["manifest_revision_sha256"]

    def test_source_checker_rejects_missing_changed_and_normalized_original(self):
        candidate = foundation.load(mapping.CANDIDATE)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.md"
            with self.assertRaises(OSError):
                mapping.verify_plan(path, candidate)
            for raw in [b"summary", b"x" * mapping.PLAN_SIZE,
                        b"\xef\xbb\xbf" + b"x" * (mapping.PLAN_SIZE - 3)]:
                path.write_bytes(raw)
                with self.assertRaises(foundation.FoundationError):
                    mapping.verify_plan(path, candidate)

    def test_source_range_is_checked_after_full_identity(self):
        # Exercise the range failure separately; mocked digest is never a real
        # source binding and the checked-in original remains an external input.
        class Digest:
            def __init__(self, value): self.value = value
            def hexdigest(self): return self.value
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.md"
            path.write_bytes(b"x" * mapping.PLAN_SIZE)
            real_sha256 = mapping.hashlib.sha256
            def source_digest(raw):
                if raw == b"x" * mapping.PLAN_SIZE:
                    return Digest(mapping.PLAN_SHA256)
                if raw == b"":  # The mock source has no lines at the bound range.
                    return Digest("0" * 64)
                return real_sha256(raw)  # Candidate JSON remains independently checked.
            with patch.object(mapping.hashlib, "sha256", side_effect=source_digest):
                with self.assertRaisesRegex(foundation.FoundationError, "PLAN_SOURCE_RANGE"):
                    mapping.verify_plan(path, foundation.load(mapping.CANDIDATE))

    def test_cli_without_original_never_claims_source_binding(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / "validate_m2_split_mapping.py")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["plan_source_check"], "NOT_RUN_ORIGINAL_REQUIRED")
        self.assertEqual(output["dataset_split_authority_mapping"], "UNRESOLVED")
        self.assertFalse(output["training_or_data_use_authorized"])


if __name__ == "__main__":
    unittest.main()
