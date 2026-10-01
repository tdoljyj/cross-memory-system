import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/model-program"))
import validate_m2_adopted_definition as adopted
import validate_m2_dataset_foundation as foundation


class OwnerAdoptedDefinitionTests(unittest.TestCase):
    def setUp(self):
        self.bundle = foundation.load(adopted.FIXTURE)

    def reseal(self):
        m = self.bundle["manifest"]
        m["manifest_revision_sha256"] = foundation.digest({
            k:v for k,v in m.items() if k != "manifest_revision_sha256"})
        for report in self.bundle["selection_reports"]:
            report["manifest_revision_sha256"] = m["manifest_revision_sha256"]

    def reject(self, code=None):
        self.reseal()
        with self.assertRaises(foundation.FoundationError) as error:
            adopted.validate_adopted_bundle(self.bundle)
        if code:
            self.assertEqual(error.exception.code, "CLUED_MODEL_M2_" + code)

    def test_formal_version_bound_to_real_owner_adoption_without_domain_receipt(self):
        original = copy.deepcopy(self.bundle)
        result = adopted.validate_adopted_bundle(self.bundle)
        ref, definition, schema, _manifest = adopted.validate_baseline()
        self.assertEqual(definition["version"], "v0.1")
        self.assertEqual(ref["owner_adoption"]["canonical_receipt_id"], "45a657d9-ba34-437e-b17c-2d792ce5c692")
        self.assertEqual(schema["$id"], adopted.SPLIT_ID)
        self.assertIsNone(ref["domain_authority_receipt_ref"])
        self.assertFalse(result["training_or_data_use_authorized"])
        self.assertEqual(result["m2_verdict"], "NOT_ISSUED")
        self.assertEqual(self.bundle, original)

    def test_wrong_or_missing_formal_reference_is_rejected_even_after_resealing(self):
        original = copy.deepcopy(self.bundle)
        for index in range(6):
            self.bundle = copy.deepcopy(original)
            self.bundle["manifest"]["splits"][index]["dataset_split_ref"]["sha256"] = "0" * 64
            with self.subTest(index=index):
                self.reject("FORMAL_SPLIT_BINDING")
        for field in ("dataset_split_ref", "candidate_definition_ref"):
            self.bundle = copy.deepcopy(original)
            del self.bundle["manifest"]["splits"][0][field]
            with self.subTest(field=field):
                self.reject("SCHEMA")

    def test_fake_owner_receipt_or_domain_authority_cannot_be_locally_promoted(self):
        for field, value in (("domain_authority_receipt_ref", {"id":"fake"}),
                             ("training_or_data_use_authorized", True),
                             ("owner_adoption", {"canonical_receipt_id":"fake"})):
            obj = foundation.load(adopted.REFERENCE)
            obj[field] = value
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "ref.json"
                import json
                path.write_text(json.dumps(obj), encoding="utf-8")
                with self.assertRaises(foundation.FoundationError) as error:
                    adopted.validate_baseline(path)
                self.assertEqual(error.exception.code, "CLUED_MODEL_M2_OWNER_ADOPTION_REFERENCE_IDENTITY")

    def test_changed_formal_artifact_fails_raw_identity(self):
        original_read = Path.read_bytes
        def changed(path):
            value = original_read(path)
            return value + b" " if path.name == "DatasetSplitDefinition.v0.1.json" else value
        with patch.object(Path, "read_bytes", changed):
            with self.assertRaises(foundation.FoundationError) as error:
                adopted.validate_baseline()
            self.assertEqual(error.exception.code, "CLUED_MODEL_M2_DOMAIN_ARTIFACT_IDENTITY")

    def test_manifest_digest_and_owner_reference_must_match(self):
        self.bundle["manifest"]["dataset_revision"] = "changed-without-reseal"
        with self.assertRaises(foundation.FoundationError) as error:
            adopted.validate_adopted_bundle(self.bundle)
        self.assertEqual(error.exception.code, "CLUED_MODEL_M2_MANIFEST_DIGEST")
        self.bundle["manifest"]["owner_adoption_reference_sha256"] = "0" * 64
        self.reject("MANIFEST_OWNER_ADOPTION_BINDING")

    def test_reused_guards_still_block_real_private_and_withdrawn_sources(self):
        original = copy.deepcopy(self.bundle)
        for field, value in (("origin", "PUBLIC_DATASET"), ("withdrawn", True),
                             ("contains_personal_data", True), ("contains_secrets", True)):
            self.bundle = copy.deepcopy(original)
            self.bundle["registry"]["sources"][0][field] = value
            with self.subTest(field=field):
                self.reject()

    def test_reused_isolation_and_selection_guards_survive_formal_projection(self):
        m = self.bundle["manifest"]
        group = next(iter(m["samples"][0]["isolation_groups"]))
        m["samples"][1]["isolation_groups"][group] = m["samples"][0]["isolation_groups"][group]
        self.reject("CROSS_SPLIT_GROUP")
        self.bundle = foundation.load(adopted.FIXTURE)
        holdout = self.bundle["manifest"]["splits"][-1]
        report = self.bundle["selection_reports"][0]
        report.update(split_id=holdout["split_id"], purpose_description=holdout["purpose_description"])
        self.reject("HOLDOUT_OR_NON_SELECTION_REPORT")

    def test_formal_binding_does_not_grant_domain_authority_or_live_currentness(self):
        self.assertEqual(adopted.main(["--require-domain-authority"]), 1)
        self.assertEqual(adopted.main(["--require-live-currentness"]), 1)
        self.assertEqual(adopted.main([]), 0)

    def test_schema_fields_are_closed_and_mapping_cannot_claim_data_clearance(self):
        self.bundle["manifest"]["splits"][0]["data_use_authorized"] = True
        self.reject("SCHEMA")
        self.bundle = foundation.load(adopted.FIXTURE)
        self.bundle["manifest"]["dataset_split_authority_mapping"] = "DOMAIN_AUTHORITY_ACCEPTED"
        self.reject("SCHEMA")


if __name__ == "__main__":
    unittest.main()
