import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/model-program/validate_m2_gold_reference.py'
sys.path.insert(0, str(SCRIPT.parent))
import validate_m2_gold_reference as m


class GoldReferenceTests(unittest.TestCase):
    def setUp(self):
        self.bundle = m.load(m.FIXTURE)
        self.raw = m.M1_SOURCE.read_bytes()

    def reseal(self):
        self.bundle['revision_sha256'] = m.digest({k: v for k, v in self.bundle.items()
                                                  if k != 'revision_sha256'})

    def reject(self, code, contract=None):
        self.reseal()
        with self.assertRaises(m.FoundationError) as caught:
            m.validate(self.bundle, m1_raw=self.raw, contract=contract)
        self.assertEqual(caught.exception.code, 'CLUED_MODEL_M2_' + code)

    def test_exact_reference_candidate_deterministic_and_immutable(self):
        before = copy.deepcopy(self.bundle)
        first = m.validate(self.bundle, m1_raw=self.raw)
        self.assertEqual(first, m.validate(self.bundle, m1_raw=self.raw))
        self.assertEqual(self.bundle, before)
        self.assertEqual(first['m1_source_identity'], 'EXACT_ACCEPTED_GIT_BLOB_BOUND')
        self.assertEqual(first['m1_reference_use'], 'REFERENCE_BASELINE_ONLY_NOT_QUALITY_THRESHOLD')
        self.assertEqual(first['m2_verdict'], 'NOT_ISSUED')
        self.assertFalse(first['training_or_data_use_authorized'])
        self.assertIsNone(first['formal_gold_ref'])

    def test_m1_source_bytes_cannot_change_even_cosmetic(self):
        for raw in [self.raw + b' ', self.raw.replace(b'false', b'true', 1)]:
            with self.subTest(raw_length=len(raw)), self.assertRaisesRegex(m.FoundationError, 'GOLD_M1_SOURCE_BYTES'):
                m.validate(self.bundle, m1_raw=raw)

    def test_m1_wrong_reference_version_head_blob_or_effect_rejected(self):
        for key in ['commit', 'git_blob_sha1', 'record_id', 'effect', 'accepted_state_version']:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle['m1_reference'][key] = 'wrong'
                self.reject('GOLD_M1_REFERENCE')

    def test_missing_and_extra_label_fields_rejected(self):
        for key in self.bundle['labels'][0]:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                del self.bundle['labels'][0][key]
                self.reject('GOLD_LABEL_SHAPE')
        self.bundle = m.load(m.FIXTURE)
        self.bundle['labels'][0]['issued'] = True
        self.reject('GOLD_LABEL_SHAPE')

    def test_duplicate_sample_and_empty_labels_rejected(self):
        self.bundle['labels'].append(copy.deepcopy(self.bundle['labels'][0]))
        self.reject('GOLD_SAMPLE_ID')
        self.bundle['labels'] = []
        self.reject('GOLD_LABELS')

    def test_source_missing_wrong_hash_revision_or_model_label_rejected(self):
        for key, value, code in [('kind', 'MODEL_MAJORITY', 'GOLD_SOURCE_KIND'),
                                 ('ref', 'synthetic-integer-addition/2', 'GOLD_SOURCE_BINDING'),
                                 ('sha256', '0' * 64, 'GOLD_SOURCE_BINDING')]:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle['labels'][0]['source'][key] = value
                self.reject(code)
        self.bundle = m.load(m.FIXTURE)
        del self.bundle['labels'][0]['source']['sha256']
        self.reject('GOLD_SOURCE_SHAPE')

    def test_rule_cannot_attest_wrong_or_boolean_label(self):
        for label in [{'answer': -999}, {'answer': True}]:
            self.bundle = m.load(m.FIXTURE)
            self.bundle['labels'][0]['label'] = label
            self.reject('GOLD_RULE_LABEL')

    def test_disputed_and_unresolved_labels_are_not_consumable(self):
        for status in ['DISPUTED', 'UNRESOLVED', 'UNKNOWN']:
            self.bundle = m.load(m.FIXTURE)
            self.bundle['labels'][0]['adjudication']['status'] = status
            self.reject('GOLD_UNRESOLVED_LABEL')

    def test_adjudication_evidence_exact_sample_input_label_source_and_roles(self):
        for key in self.bundle['labels'][0]['adjudication']['evidence']:
            with self.subTest(key=key):
                self.bundle = m.load(m.FIXTURE)
                self.bundle['labels'][0]['adjudication']['evidence'][key] = 'stale'
                self.reject('GOLD_ADJUDICATION_BINDING')
        self.bundle = m.load(m.FIXTURE)
        del self.bundle['labels'][0]['adjudication']['evidence']
        self.reject('GOLD_ADJUDICATION_SHAPE')

    def test_reviewer_separation_is_synthetic_not_real_identity(self):
        row = self.bundle['labels'][0]
        row['adjudication']['reviewer_id'] = row['annotator_id']
        self.reject('GOLD_SYNTHETIC_ROLE_SEPARATION')
        self.bundle = m.load(m.FIXTURE)
        self.bundle['labels'][0]['adjudication']['reviewer_id'] = 'pretend-real-owner'
        self.reject('GOLD_SYNTHETIC_ROLE_SEPARATION')

    def test_changed_input_or_revision_cannot_reuse_old_adjudication(self):
        self.bundle['labels'][0]['input']['left'] += 1
        self.bundle['labels'][0]['label']['answer'] += 1
        self.reject('GOLD_ADJUDICATION_BINDING')
        self.bundle = m.load(m.FIXTURE)
        self.bundle['gold_revision'] = 'synthetic-gold/2'
        self.reject('GOLD_ADJUDICATION_BINDING')

    def test_missing_parent_input_never_falls_back_to_synthetic_gold(self):
        self.bundle['labels'][0]['source'] = {'kind': 'UPSTREAM_GOLD',
            'ref': {'stage': 'IF-MVP0-C', 'relative_path': 'gold.json', 'sha256': '0'*64},
            'sha256': '0'*64}
        self.reject('GOLD_PARENT_INPUT_REQUIRED')

    def test_formal_authority_and_parent_reader_substitution_rejected(self):
        for key in ['formal_gold_ref', 'domain_receipt_ref', 'independent_review_ref',
                    'holdout_lock_ref', 'threshold_ref']:
            with self.subTest(key=key):
                contract = m.load(m.CONTRACT)
                contract[key] = {'status': 'ISSUED'}
                self.reject('GOLD_FORMAL_EVIDENCE_NOT_ISSUED', contract)
        contract = m.load(m.CONTRACT)
        contract['parent_reader']['sha256'] = '0'*64
        self.reject('GOLD_PARENT_READER', contract)

    def test_changed_revision_digest_and_claimed_authority_rejected(self):
        self.bundle['revision_sha256'] = '0'*64
        with self.assertRaisesRegex(m.FoundationError, 'GOLD_REVISION_DIGEST'):
            m.validate(self.bundle, m1_raw=self.raw)
        self.bundle['authority_effect'] = 'ISSUED'
        self.reject('GOLD_CANDIDATE_EFFECT')

    def test_parent_stage_and_path_escape_rejected_before_reader(self):
        roots = {stage: '.' for stage in ['IF-MVP0-A', 'IF-MVP0-B', 'IF-MVP0-C']}
        for relative in ['../outside', '/outside', 'C:/outside', 'folder\\outside']:
            with self.subTest(relative=relative), patch.object(m.subprocess, 'run') as reader:
                with self.assertRaisesRegex(m.FoundationError, 'GOLD_PARENT_PATH'):
                    m.read_parent_gold({'stage': 'IF-MVP0-C', 'relative_path': relative, 'sha256': '0'*64}, roots)
                reader.assert_not_called()
        with self.assertRaisesRegex(m.FoundationError, 'GOLD_PARENT_STAGE'):
            m.read_parent_gold({'stage': 'UNKNOWN', 'relative_path': 'gold.json', 'sha256': '0'*64}, roots)

    def test_parent_seal_cannot_be_replaced_by_caller_rehashed_leaf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'SHA256SUMS').write_text('0'*64 + '  gold.json\n', encoding='utf-8')
            (root/'gold.json').write_text('{}', encoding='utf-8')
            evidence = {'status': 'PASS_SOURCE_BINDING_ONLY', 'parents': [
                {'stage': 'IF-MVP0-C', 'delivery_root_sha256': 'd46ae622dc19d2355a92af4b0eacdd15756a8eeeb775c0a6bff0e9c5537fb7c1'}]}
            result = subprocess.CompletedProcess([], 0, json.dumps(evidence), '')
            roots = {stage: directory for stage in ['IF-MVP0-A', 'IF-MVP0-B', 'IF-MVP0-C']}
            with patch.object(m.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(m.FoundationError, 'GOLD_PARENT_SEAL'):
                    m.read_parent_gold({'stage': 'IF-MVP0-C', 'relative_path': 'gold.json',
                                       'sha256': m.hashlib.sha256(b'{}').hexdigest()}, roots)

    def test_cli_and_formal_gate_and_missing_m1_source(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        denied = subprocess.run([sys.executable, str(SCRIPT), '--require-formal-gold'],
                                capture_output=True, text=True)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(json.loads(denied.stdout)['error'], 'CLUED_MODEL_M2_GOLD_FORMAL_EVIDENCE_REQUIRED')
        with tempfile.TemporaryDirectory() as directory:
            denied = subprocess.run([sys.executable, str(SCRIPT), '--m1-source', str(Path(directory)/'missing')],
                                    capture_output=True, text=True)
            self.assertEqual(denied.returncode, 1)


if __name__ == '__main__':
    unittest.main()
