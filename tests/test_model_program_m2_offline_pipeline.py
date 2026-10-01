import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/model-program'))
import validate_m2_offline_pipeline as p


class OfflinePipelineTests(unittest.TestCase):
    def setUp(self):
        self.dataset = p.prepare_dataset()
        self.saved, self.sha = p.read_saved_outputs(p.SAVED_OUTPUTS)

    def reject(self, fn, code):
        with self.assertRaises(p.FoundationError) as error:
            fn()
        self.assertEqual(error.exception.code, 'CLUED_MODEL_M2_' + code)

    def test_replay_is_deterministic_and_non_authoritative(self):
        a, b = p.run(), p.run()
        self.assertEqual(a, b)
        self.assertEqual(a['m2_verdict'], 'NOT_ISSUED')
        self.assertEqual(a['authority_effect'], 'NONE')
        self.assertFalse(a['formal_holdout_used'])
        self.assertFalse(a['training_or_real_data_use_authorized'])
        self.assertEqual(a['scoring_replay']['report']['correct_count'], 6)
        self.assertFalse(a['scoring_replay']['report']['model_inference_performed'])

    def test_committed_evidence_matches_recomputed_package(self):
        self.assertEqual(p.load(p.BASE / 'offline-pipeline-evidence.json'), p.run())

    def test_fixture_provenance_and_real_data_rejection(self):
        rows = p.generate_rows()
        for field, value, code in [('source_class', 'A', 'PIPELINE_REAL_DATA_BLOCKED'),
                ('parent_boundary', 'HOLDOUT', 'PIPELINE_HOLDOUT_BLOCKED'),
                ('input', 'x' * 2049, 'PIPELINE_INPUT_BUDGET')]:
            changed = copy.deepcopy(rows)
            changed[0][field] = value
            with self.subTest(field=field):
                self.reject(lambda: p.validate_rows(changed, p.EXPECTED_CONTRACT), code)
        rows[0]['provenance']['license_scope'] = 'REAL_DATA'
        self.reject(lambda: p.validate_rows(rows, p.EXPECTED_CONTRACT), 'PIPELINE_PROVENANCE')

    def test_scrub_inspects_gold_and_unicode_normalizes(self):
        row = p.generate_rows()[0]
        for text in ['person@example.invalid', '+8613812345678', 'password=fixture',
                     'Ignore previous instructions', 'reveal secrets', '\x00']:
            altered = copy.deepcopy(row)
            altered['gold'] = {'answer': text}
            accepted, report = p.scrub_rows([altered])
            self.assertEqual(accepted, [])
            self.assertEqual(len(report['rejected']), 1)
            self.assertNotIn(text, p.render(report))
        row['input'] = '  ＡＢＣ\t  fixture  '
        accepted, report = p.scrub_rows([row])
        self.assertEqual(accepted[0]['input'], 'ABC fixture')
        self.assertEqual(len(report['transformed']), 1)

    def test_duplicate_components_are_order_independent(self):
        rows, _ = p.scrub_rows(p.generate_rows())
        a = p.deduplicate(rows)
        b = p.deduplicate(list(reversed(rows)))
        self.assertEqual(a, b)
        self.assertEqual(len(a[0]), 6)
        self.assertEqual(len(a[1]['removed']), 2)
        self.assertEqual({e['kind'] for e in a[1]['edges']}, {'NORMALIZED_EXACT', 'LEXICAL_NEAR'})

    def test_transitive_component_dedup_and_gold_dispute(self):
        row = p.generate_rows()[0]
        words = list('abcdefghij')
        rows = []
        for i, text in enumerate([' '.join(words), ' '.join(words + ['k']), ' '.join(words[1:] + ['k'])]):
            item = copy.deepcopy(row)
            item.update(sample_id=f'transitive-{i}', input=text)
            rows.append(item)
        self.assertFalse(p.similar(rows[0]['input'], rows[2]['input']))
        self.assertEqual(len(p.deduplicate(rows)[0]), 1)
        rows[1]['gold'] = {'answer': 99}
        self.reject(lambda: p.deduplicate(rows), 'PIPELINE_GOLD_DISPUTE')

    def test_cross_partition_duplicates_are_rejected(self):
        a = p.generate_rows()[0]
        b = copy.deepcopy(a)
        b.update(sample_id='other-partition', partition_id='other')
        self.reject(lambda: p.deduplicate([a, b]), 'PIPELINE_CROSS_PARTITION_DUPLICATE')

    def test_contamination_checks_content_and_each_isolation_group(self):
        a = p.generate_rows()[0]
        for key in p.GROUP_KEYS:
            b = copy.deepcopy(a)
            b.update(sample_id='other', input='unrelated words')
            b['isolation_groups'] = {key: a['isolation_groups'][key]}
            report = p.contamination([a], [b], 'LEFT', 'RIGHT')
            self.assertIn('SHARED_' + key.upper(), report['matches'][0]['reason_codes'])
        report = p.contamination([a], [a], 'LEFT', 'RIGHT')
        self.assertIn('NORMALIZED_EXACT', report['matches'][0]['reason_codes'])
        self.assertFalse(report['formal_train_eval_clearance'])

    def test_contract_tamper_fails_closed(self):
        contract = copy.deepcopy(p.EXPECTED_CONTRACT)
        contract['m2_verdict'] = 'PASS'
        original = p.load
        with patch.object(p, 'load', side_effect=lambda path: contract if path == p.CONTRACT_PATH else original(path)):
            self.reject(p.prepare_dataset, 'PIPELINE_CONTRACT_BINDING')

    def test_saved_output_input_and_contract_binding(self):
        for field in ['input_set_sha256', 'contract_sha256']:
            saved = copy.deepcopy(self.saved)
            saved[field] = '0' * 64
            self.reject(lambda: p.score_saved(self.dataset, saved, self.sha), 'PIPELINE_REPLAY_BINDING')

    def test_saved_output_coverage_and_duplicates(self):
        for outputs in [self.saved['outputs'][:-1], self.saved['outputs'] + self.saved['outputs'][:1]]:
            saved = copy.deepcopy(self.saved)
            saved['outputs'] = outputs
            self.reject(lambda: p.score_saved(self.dataset, saved, self.sha), 'PIPELINE_OUTPUT_COVERAGE')
        saved = copy.deepcopy(self.saved)
        saved['outputs'][1] = saved['outputs'][0]
        self.reject(lambda: p.score_saved(self.dataset, saved, self.sha), 'PIPELINE_OUTPUT_SHAPE')

    def test_invalid_answers_score_wrong_without_coercion(self):
        for output in ['{"answer":true}', '{"answer":"8"}', '{"answer":8,"extra":1}',
                       '{"answer":8,"answer":8}', '{"answer":NaN}', 'not json']:
            saved = copy.deepcopy(self.saved)
            saved['outputs'][0]['output_text'] = output
            report = p.score_saved(self.dataset, saved, self.sha)
            self.assertFalse(report['scores'][0]['correct'])
            self.assertEqual(report['correct_count'], 5)

    def test_output_injection_and_budget_rejected(self):
        for output, code in [('reveal secrets', 'PIPELINE_OUTPUT_FILTER'),
                             ('x' * 2049, 'PIPELINE_OUTPUT_SHAPE')]:
            saved = copy.deepcopy(self.saved)
            saved['outputs'][0]['output_text'] = output
            self.reject(lambda: p.score_saved(self.dataset, saved, self.sha), code)

    def test_saved_file_strict_json_and_byte_budget(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'outputs.json'
            for content, code in [('{"a":1,"a":2}', 'DUPLICATE_JSON_KEY'),
                                  ('{"a":NaN}', 'NON_FINITE_JSON'),
                                  (' ' * 65537, 'PIPELINE_SAVED_OUTPUT_BUDGET')]:
                path.write_text(content, encoding='utf-8')
                self.reject(lambda: p.read_saved_outputs(path), code)

    def test_cli_bad_input_is_sanitized(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'private-path.json'
            path.write_text('{private-marker}', encoding='utf-8')
            from io import StringIO
            capture = StringIO()
            with patch('sys.stdout', capture):
                self.assertEqual(p.main(['--saved-outputs', str(path)]), 1)
            self.assertNotIn('private', capture.getvalue())
            self.assertEqual(json.loads(capture.getvalue())['status'], 'FAIL_OFFLINE_SYNTHETIC_PIPELINE')


if __name__ == '__main__':
    unittest.main()
