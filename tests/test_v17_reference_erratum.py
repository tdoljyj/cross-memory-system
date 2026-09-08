"""Evidence corruption must never be accepted as a reference correction."""
import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('v17_verify', ROOT / 'scripts/verify-v17-reference-erratum.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReferenceErratumTests(unittest.TestCase):
    def setUp(self):
        self.correction = json.loads((ROOT / module.ERRATUM).read_text(encoding='utf-8'))

    def test_frozen_evidence_resolves(self):
        result = module.verify(ROOT, self.correction)
        self.assertEqual(result['manifest_files_verified'], 88)
        self.assertEqual(result['acceptance_references_verified'], 10)

    def test_wrong_digest_is_rejected(self):
        self.correction['correction']['corrected_value'] = 'sha256:' + '0' * 64
        with self.assertRaisesRegex(ValueError, 'digest mismatch'):
            module.verify(ROOT, self.correction)

    def test_wrong_original_receipt_is_rejected(self):
        self.correction['original_receipt']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'receipt changed'):
            module.verify(ROOT, self.correction)

    def test_wrong_candidate_is_rejected(self):
        self.correction['accepted_candidate'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'candidate binding'):
            module.verify(ROOT, self.correction)

    def test_archive_cannot_escape_repository(self):
        self.correction['original_zip']['path'] = '../outside.zip'
        with self.assertRaisesRegex(ValueError, 'outside repository'):
            module.verify(ROOT, self.correction)

    def test_cannot_expand_authority(self):
        self.correction['production_effect'] = 'ACCEPTED'
        with self.assertRaisesRegex(ValueError, 'expands authority'):
            module.verify(ROOT, self.correction)


if __name__ == '__main__':
    unittest.main()
