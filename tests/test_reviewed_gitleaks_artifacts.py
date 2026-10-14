import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reviewed_gitleaks', ROOT / 'scripts/ci/reviewed_gitleaks.py')
reviewed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reviewed)


class ReviewedArtifactDigestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = (ROOT / '.gitleaks.toml').read_text(encoding='utf-8')
        cls.text = reviewed.run([
            'git', 'cat-file', 'blob',
            f'{reviewed.REVIEW_DOCUMENT_COMMIT}:{reviewed.REVIEW_DOCUMENT_PATH}',
        ], cwd=ROOT).decode('utf-8')

    def test_both_actual_immutable_artifacts_match_review_digests(self):
        for line in reviewed.REVIEW_DOCUMENT_DIGEST_LINES:
            reviewed.verify_auth_review_digest(ROOT, self.text, line)

    def test_new_commit_is_not_the_reviewed_exception(self):
        text = self.config.replace(
            reviewed.REVIEW_DOCUMENT_COMMIT + ':' + reviewed.REVIEW_DOCUMENT_PATH,
            '0' * 40 + ':' + reviewed.REVIEW_DOCUMENT_PATH,
        )
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            reviewed.parse_records(text)

    def test_different_report_path_is_not_admitted(self):
        text = self.config.replace(reviewed.REVIEW_DOCUMENT_PATH, 'development/contracts/context-authorization/evidence/other.json')
        with self.assertRaisesRegex(ValueError, 'Non-exact finding location'):
            reviewed.parse_records(text)

    def test_unreviewed_line_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Unreviewed authorization digest line'):
            reviewed.verify_auth_review_digest(ROOT, self.text, 151)

    def test_changed_report_bytes_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'review bytes changed'):
            reviewed.verify_auth_review_digest(ROOT, self.text + '\n', 150)

    def test_changed_source_bytes_are_rejected(self):
        with patch.object(reviewed, 'run', return_value=b'changed artifact'):
            with self.assertRaisesRegex(ValueError, 'differs from immutable artifact'):
                reviewed.verify_auth_review_digest(ROOT, self.text, 150)

    def test_default_detection_cannot_be_disabled(self):
        with self.assertRaisesRegex(ValueError, 'Default detection rules'):
            reviewed.parse_records(self.config.replace('useDefault = true', 'useDefault = false'))

    def test_exact_record_count_and_artifact_reason(self):
        records = reviewed.parse_records(self.config)
        exact = [r for r in records if ':' + reviewed.REVIEW_DOCUMENT_PATH + ':' in r['fingerprint']]
        self.assertEqual(len(records), 484)
        self.assertEqual(len(exact), 2)
        self.assertTrue(all(r['kinds'] == ['ARTIFACT_DIGEST'] for r in exact))


if __name__ == '__main__':
    unittest.main()
