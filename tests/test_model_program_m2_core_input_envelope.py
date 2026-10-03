import copy
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/model-program'))
import validate_m2_core_input_envelope as m


class CoreInputEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.bundle = m.load(m.core.FIXTURE)
        self.source_contract = m.load(m.core.CONTRACT)
        self.contract = m.load(m.CONTRACT)
        self.envelope = m.load(m.FIXTURE)

    def validate(self, envelope=None, **kwargs):
        return m.validate(self.envelope if envelope is None else envelope,
                          self.bundle, self.source_contract, self.contract, **kwargs)

    def reject(self, envelope, code):
        with self.assertRaises(m.FoundationError) as error:
            self.validate(envelope)
        self.assertEqual(error.exception.code, 'CLUED_MODEL_M2_' + code)

    @staticmethod
    def reseal(envelope):
        envelope['revision_sha256'] = m.digest({k: v for k, v in envelope.items()
                                               if k != 'revision_sha256'})

    def test_committed_projection_replays_without_source_mutation(self):
        before = copy.deepcopy(self.bundle)
        first = m.build_envelope(self.bundle, self.source_contract, self.contract)
        self.assertEqual(first, self.envelope)
        self.assertEqual(first, m.build_envelope(self.bundle, self.source_contract, self.contract))
        self.assertEqual(before, self.bundle)
        result = self.validate()
        self.assertEqual(result['development_inputs'], 24)
        self.assertEqual(result['model_calls'], 0)
        self.assertEqual(result['call_admission'], 'NOT_ISSUED')

    def test_payload_contains_exact_inputs_without_label_or_review_metadata(self):
        by_id = {row['sample_id']: row for row in self.bundle['samples']}
        for request in self.envelope['requests']:
            self.assertEqual(set(request), set(self.contract['request_fields']))
            self.assertEqual(request['input'], by_id[request['sample_id']]['input'])
            self.assertEqual(request['input_sha256'], m.digest(request['input']))
            self.assertNotIn('answer_candidate', request)
            self.assertNotIn('review', request)

    def test_input_projection_is_detached_from_source_objects(self):
        envelope = m.build_envelope(self.bundle, self.source_contract, self.contract)
        envelope['requests'][0]['input']['messages'][0]['content'] = 'changed'
        self.assertNotEqual(envelope['requests'][0]['input'], self.bundle['samples'][0]['input'])
        self.assertEqual(self.bundle, m.load(m.core.FIXTURE))

    def test_answer_review_and_execution_fields_are_rejected_even_rehashed(self):
        for field, value in [('answer_candidate', {'answer': 'injected'}),
                             ('review', {'status': 'PASS'}), ('command', 'injected')]:
            envelope = copy.deepcopy(self.envelope)
            envelope['requests'][0][field] = value
            self.reseal(envelope)
            self.reject(envelope, 'CORE_INPUT_REQUEST_SHAPE')

    def test_relabelled_protected_partition_is_rejected(self):
        for partition in ['QUALIFICATION', 'FINAL_HOLDOUT']:
            envelope = copy.deepcopy(self.envelope)
            envelope['requests'][0]['partition'] = partition
            self.reseal(envelope)
            self.reject(envelope, 'CORE_INPUT_PROTECTED_PARTITION')

    def test_changed_input_with_new_digests_cannot_pass_source_binding(self):
        envelope = copy.deepcopy(self.envelope)
        envelope['requests'][0]['input']['messages'][0]['content'] = 'injected answer hint'
        envelope['requests'][0]['input_sha256'] = m.digest(envelope['requests'][0]['input'])
        self.reseal(envelope)
        self.reject(envelope, 'CORE_INPUT_SOURCE_BINDING')

    def test_input_hash_is_independently_checked(self):
        envelope = copy.deepcopy(self.envelope)
        envelope['requests'][0]['input_sha256'] = '0' * 64
        self.reseal(envelope)
        self.reject(envelope, 'CORE_INPUT_DIGEST')

    def test_coverage_duplicate_reorder_and_domain_rebinding_are_rejected(self):
        envelope = copy.deepcopy(self.envelope)
        envelope['requests'].pop()
        self.reseal(envelope)
        self.reject(envelope, 'CORE_INPUT_COVERAGE')
        for mutate in [lambda e: e['requests'].__setitem__(1, copy.deepcopy(e['requests'][0])),
                       lambda e: e['requests'].reverse(),
                       lambda e: e['requests'][0].__setitem__('domain', 'context')]:
            envelope = copy.deepcopy(self.envelope)
            mutate(envelope)
            self.reseal(envelope)
            self.reject(envelope, 'CORE_INPUT_SOURCE_BINDING')

    def test_stale_revision_and_forged_authority_are_rejected(self):
        for field, value in [('source_bundle_revision_sha256', '0' * 64),
                             ('source_contract_sha256', '0' * 64),
                             ('source_rule_sha256', '0' * 64),
                             ('model_call_profile_ref', 'declared-not-authorized'),
                             ('formal_domain_receipt_ref', 'fake-receipt'),
                             ('dispatch', 'AUTHORIZED'), ('m2_verdict', 'PASS')]:
            envelope = copy.deepcopy(self.envelope)
            envelope[field] = value
            self.reseal(envelope)
            self.reject(envelope, 'CORE_INPUT_SOURCE_BINDING')

    def test_source_and_license_checks_reuse_existing_validator(self):
        self.bundle['samples'][0]['source']['license_scope'] = 'REAL_DATA_AUTHORIZED'
        with self.assertRaises(m.FoundationError):
            self.validate()
        self.bundle = m.load(m.core.FIXTURE)
        self.bundle['samples'][0]['answer_candidate'] = {'rewritten': True}
        with self.assertRaises(m.FoundationError):
            self.validate()

    def test_contract_cannot_add_license_or_dispatch_authority(self):
        for field, value in [('license_scope', 'REAL_DATA_AUTHORIZED'),
                             ('dispatch', 'AUTHORIZED'), ('partition', 'FINAL_HOLDOUT'),
                             ('segment_handling', 'PROMOTE_SOURCE_SYSTEM_TO_MODEL_SYSTEM')]:
            contract = copy.deepcopy(self.contract)
            contract[field] = value
            with self.assertRaisesRegex(m.FoundationError, 'CORE_INPUT_CONTRACT'):
                m.build_envelope(self.bundle, self.source_contract, contract)

    def test_formal_admission_fails_closed(self):
        with self.assertRaisesRegex(m.FoundationError, 'CORE_INPUT_CALL_ADMISSION_REQUIRED'):
            self.validate(require_call_admission=True)
        capture = StringIO()
        with redirect_stdout(capture):
            self.assertEqual(m.main(['--require-call-admission']), 1)
        self.assertEqual(json.loads(capture.getvalue())['error'],
                         'CLUED_MODEL_M2_CORE_INPUT_CALL_ADMISSION_REQUIRED')

    def test_cli_sanitizes_input_errors_and_reuses_strict_json_loader(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'private-marker.json'
            for text, code in [('{"requests":[],"requests":[]}', 'DUPLICATE_JSON_KEY'),
                               ('{"requests":NaN}', 'NON_FINITE_JSON'),
                               ('private-content', 'INVALID_INPUT')]:
                path.write_text(text, encoding='utf-8')
                capture = StringIO()
                with redirect_stdout(capture):
                    self.assertEqual(m.main(['--envelope', str(path)]), 1)
                self.assertEqual(json.loads(capture.getvalue())['error'], 'CLUED_MODEL_M2_' + code)
                self.assertNotIn('private', capture.getvalue())


if __name__ == '__main__':
    unittest.main()
