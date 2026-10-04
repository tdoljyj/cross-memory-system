import copy
from contextlib import redirect_stdout
from io import StringIO
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/model-program'))
import score_m2_core_saved_outputs as m


class CoreSavedOutputTests(unittest.TestCase):
    def setUp(self):
        self.source_raw = m.core.FIXTURE.read_bytes()
        self.source_contract_raw = m.core.CONTRACT.read_bytes()
        self.contract = m.load(m.CONTRACT)
        self.saved_raw = m.FIXTURE.read_bytes()
        self.saved = m.strict_json(self.saved_raw)

    def score(self, saved=None, raw=None):
        if raw is None:
            raw = self.saved_raw if saved is None else m.offline.render(saved).encode('utf-8')
        return m.score_saved(self.source_raw, self.source_contract_raw, raw, self.contract)

    def output_for(self, saved, domain):
        return next(o for o in saved['outputs'] if '-' + domain + '-' in o['sample_id'])

    def mutate_answer(self, saved, domain, mutation):
        output = self.output_for(saved, domain)
        answer = m.strict_json(output['output_text'].encode('utf-8'))
        mutation(answer)
        output['output_text'] = m.offline.render(answer)
        return output['sample_id']

    def test_public_24_deterministic_candidate_copy_replay(self):
        self.assertEqual(self.saved, m.generate_fixture(self.source_raw, self.source_contract_raw, self.contract))
        first = self.score()
        self.assertEqual(first, self.score())
        self.assertEqual(first, m.run())
        self.assertEqual(first['correct_count'], 24)
        self.assertEqual(first['schema_valid_count'], 24)
        self.assertEqual(first['reference_valid_count'], 24)
        self.assertEqual({s['domain'] for s in first['scores']}, set(m.core.DOMAINS))
        self.assertFalse(first['formal_eval_acceptance'])
        self.assertFalse(first['model_inference_performed'])
        self.assertEqual(first['m2_verdict'], 'NOT_ISSUED')
        self.assertEqual(first['holdout_generated'], 0)
        self.assertEqual(self.source_raw, m.core.FIXTURE.read_bytes())

    def test_schema_valid_semantically_wrong_each_domain(self):
        mutations = {
            'utterance_card': lambda a: a['items'][0].__setitem__('claim', 'different candidate claim'),
            'card_chain': lambda a: a.__setitem__('suggested_before', 'card_Z'),
            'imprint': lambda a: a.__setitem__('conflict', not a['conflict']),
            'context': lambda a: a.__setitem__('candidate_eligible', not a['candidate_eligible']),
        }
        for domain, mutation in mutations.items():
            saved = copy.deepcopy(self.saved)
            sid = self.mutate_answer(saved, domain, mutation)
            score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
            self.assertTrue(score['schema_valid'], domain)
            self.assertTrue(score['reference_valid'], domain)
            self.assertFalse(score['correct'], domain)

    def test_reference_membership_does_not_prove_quote_semantics(self):
        saved = copy.deepcopy(self.saved)
        sid = self.mutate_answer(saved, 'utterance_card',
            lambda a: a['items'][0]['source_anchors'][0].__setitem__(
                'exact_quote', 'This quote is absent from the public source message.'))
        score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
        self.assertTrue(score['schema_valid'])
        self.assertTrue(score['reference_valid'])
        self.assertFalse(score['correct'])

    def test_wrong_nested_types_and_bool_int_do_not_coerce(self):
        mutations = {
            'utterance_card': lambda a: a['items'][0]['source_anchors'][0].__setitem__('exact_quote', 1),
            'card_chain': lambda a: a.__setitem__('anchor_message_ids', [1]),
            'imprint': lambda a: a.__setitem__('claims', [{'content': 'wrong nested type'}]),
            'context': lambda a: a.__setitem__('candidate_eligible', 1),
        }
        for domain, mutation in mutations.items():
            saved = copy.deepcopy(self.saved)
            sid = self.mutate_answer(saved, domain, mutation)
            score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
            self.assertFalse(score['schema_valid'], domain)
            self.assertFalse(score['correct'], domain)

    def test_unknown_fields_closed_in_each_domain(self):
        for domain in m.core.DOMAINS:
            saved = copy.deepcopy(self.saved)
            sid = self.mutate_answer(saved, domain, lambda a: a.__setitem__('unknown', 'value'))
            score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
            self.assertFalse(score['schema_valid'], domain)
        saved = copy.deepcopy(self.saved)
        sid = self.mutate_answer(saved, 'utterance_card',
                                 lambda a: a['items'][0]['source_anchors'][0].__setitem__('unknown', True))
        self.assertFalse(next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)['schema_valid'])

    def test_bad_references_remain_schema_valid_but_incorrect(self):
        mutations = {
            'utterance_card': lambda a: a['items'][0]['source_anchors'][0].__setitem__('message_id', 'missing'),
            'card_chain': lambda a: a.__setitem__('anchor_message_ids', ['missing']),
            'imprint': lambda a: a.__setitem__('premise_message_id', 'missing'),
            'context': lambda a: a.__setitem__('policy_message_id', 'missing'),
        }
        for domain, mutation in mutations.items():
            saved = copy.deepcopy(self.saved)
            sid = self.mutate_answer(saved, domain, mutation)
            score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
            self.assertTrue(score['schema_valid'], domain)
            self.assertFalse(score['reference_valid'], domain)
            self.assertFalse(score['correct'], domain)

    def test_segment_reference_and_temporal_nested_schema(self):
        saved = copy.deepcopy(self.saved)
        sid = self.mutate_answer(saved, 'utterance_card', lambda a: a.__setitem__('segment_id', 'another'))
        score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
        self.assertTrue(score['schema_valid'])
        self.assertFalse(score['reference_valid'])
        saved = copy.deepcopy(self.saved)
        sid = self.mutate_answer(saved, 'utterance_card', lambda a: a['items'][0].__setitem__(
            'temporal_mentions', [{'kind': 'due_at', 'source_text': 'tomorrow', 'source_message_id': 7}]))
        self.assertFalse(next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)['schema_valid'])

    def test_wrong_execute_flag_is_semantic_wrong_not_schema_wrong(self):
        for domain in ('card_chain', 'context'):
            saved = copy.deepcopy(self.saved)
            sid = self.mutate_answer(saved, domain, lambda a: a.__setitem__('execute', True))
            score = next(s for s in self.score(saved)['scores'] if s['sample_id'] == sid)
            self.assertTrue(score['schema_valid'])
            self.assertFalse(score['correct'])

    def test_original_output_utf8_bytes_preserved_without_normalizing(self):
        first = self.score()
        saved = copy.deepcopy(self.saved)
        original = saved['outputs'][0]['output_text']
        saved['outputs'][0]['output_text'] = ' \n' + original + '\t'
        second = self.score(saved)
        a, b = first['scores'][0], second['scores'][0]
        self.assertTrue(a['correct'] and b['correct'])
        self.assertEqual(a['parsed_output_sha256'], b['parsed_output_sha256'])
        self.assertNotEqual(a['output_text_raw_utf8_sha256'], b['output_text_raw_utf8_sha256'])
        self.assertEqual(b['output_text_raw_utf8_sha256'], m.raw_sha((' \n' + original + '\t').encode('utf-8')))
        self.assertNotEqual(first['score_sha256'], second['score_sha256'])

    def test_saved_envelope_raw_byte_drift_binds_report_replay(self):
        first = self.score()
        second = self.score(raw=self.saved_raw + b'\n')
        self.assertEqual(first['scores'], second['scores'])
        self.assertNotEqual(first['saved_outputs_raw_sha256'], second['saved_outputs_raw_sha256'])
        with self.assertRaises(m.FoundationError):
            m.validate_report(first, self.source_raw, self.source_contract_raw,
                              self.saved_raw + b'\n', self.contract)

    def test_input_and_source_contract_raw_byte_bindings_fail_closed(self):
        for source, source_contract in [(self.source_raw + b'\n', self.source_contract_raw),
                                        (self.source_raw, self.source_contract_raw + b'\n')]:
            with self.assertRaises(m.FoundationError):
                m.score_saved(source, source_contract, self.saved_raw, self.contract)

    def test_revision_and_primitive_policy_bindings_fail_closed(self):
        for field in ('contract_sha256', 'dataset_revision_sha256', 'evaluation_revision_sha256'):
            saved = copy.deepcopy(self.saved)
            saved[field] = '0' * 64
            with self.assertRaises(m.FoundationError):
                self.score(saved)
        contract = copy.deepcopy(self.contract)
        del contract['schema_policy']
        with self.assertRaises(m.FoundationError):
            m.score_saved(self.source_raw, self.source_contract_raw, self.saved_raw, contract)
        with patch.object(m, 'raw_sha', return_value='0' * 64):
            with self.assertRaises(m.FoundationError):
                self.score()

    def test_duplicate_missing_foreign_coverage_rejected(self):
        for change in [lambda s: s['outputs'].pop(),
                       lambda s: s['outputs'].__setitem__(1, copy.deepcopy(s['outputs'][0])),
                       lambda s: s['outputs'][0].__setitem__('sample_id', 'foreign-sample')]:
            saved = copy.deepcopy(self.saved)
            change(saved)
            with self.assertRaises(m.FoundationError):
                self.score(saved)

    def test_outer_authority_and_origin_false_claims_rejected(self):
        for field, value in [('origin', 'MODEL_OUTPUT'), ('source_class', 'A'),
                             ('partition', 'FINAL_HOLDOUT'), ('model_call_profile_ref', 'claimed'),
                             ('formal_gold_ref', 'claimed'), ('holdout_material', {'seed': 'claimed'}),
                             ('model_inference_performed', True), ('m2_verdict', 'PASS'),
                             ('authority_effect', 'ACCEPTED')]:
            saved = copy.deepcopy(self.saved)
            saved[field] = value
            with self.assertRaises(m.FoundationError):
                self.score(saved)
        for field in ('teacher_output', 'seed', 'gold', 'protected48'):
            saved = copy.deepcopy(self.saved)
            saved[field] = 'forbidden'
            with self.assertRaises(m.FoundationError):
                self.score(saved)

    def test_strict_duplicate_nonfinite_and_utf8_fail_closed(self):
        for text in ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":1e999}', 'not json']:
            saved = copy.deepcopy(self.saved)
            saved['outputs'][0]['output_text'] = text
            with self.assertRaises((ValueError, m.FoundationError)):
                self.score(saved)
        for raw in [b'\xff', b'{"outputs":[],"outputs":[]}', b'{"a":NaN}']:
            with self.assertRaises((ValueError, m.FoundationError)):
                self.score(raw=raw)
        saved = copy.deepcopy(self.saved)
        saved['outputs'][0]['output_text'] = '\ud800'
        with self.assertRaises(UnicodeError):
            self.score(raw=json.dumps(saved).encode('utf-8'))

    def test_nonobject_json_is_schema_invalid_not_a_crash(self):
        for answer in (None, [], 'string', 1, True):
            saved = copy.deepcopy(self.saved)
            saved['outputs'][0]['output_text'] = m.offline.render(answer)
            self.assertEqual(self.score(saved)['schema_valid_count'], 23)

    def test_report_binds_schema_rules_renderer_and_references_without_plaintext(self):
        report = self.score()
        evaluation = report['evaluation_revision']
        self.assertEqual(evaluation['scorer'], self.contract['scorer'])
        self.assertEqual(evaluation['renderer'], m.offline.EXPECTED_CONTRACT['renderer'])
        self.assertEqual(evaluation['primitive_scorer'], m.offline.EXPECTED_CONTRACT['scorer'])
        self.assertEqual(evaluation['schema_binding']['domain_rules'], m.core.RULES)
        rendered = m.offline.render(report)
        for output in self.saved['outputs']:
            self.assertNotIn(output['output_text'], rendered)
        self.assertNotIn('answer_candidate', report)
        report['correct_count'] = 0
        with self.assertRaises(m.FoundationError):
            m.validate_report(report, self.source_raw, self.source_contract_raw, self.saved_raw, self.contract)

    def test_cli_fixed_public_path_and_failure_does_not_echo(self):
        with self.assertRaises(SystemExit):
            m.main(['--saved-outputs', 'protected48.json'])
        stream = StringIO()
        with patch.object(m, 'run', side_effect=ValueError('private answer')), redirect_stdout(stream):
            code = m.main([])
        self.assertEqual(code, 1)
        self.assertNotIn('private answer', stream.getvalue())
        self.assertEqual(json.loads(stream.getvalue())['status'], 'FAIL_CLOSED_CORE_SAVED_OUTPUT_SCORE')

    def test_saved_output_byte_and_field_budgets(self):
        with self.assertRaises(m.FoundationError):
            self.score(raw=b' ' * (self.contract['max_saved_bytes'] + 1))
        saved = copy.deepcopy(self.saved)
        saved['outputs'][0]['output_text'] = 'x' * (self.contract['max_output_chars'] + 1)
        with self.assertRaises(m.FoundationError):
            self.score(saved)


if __name__ == '__main__':
    unittest.main()
