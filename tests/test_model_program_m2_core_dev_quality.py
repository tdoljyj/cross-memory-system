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
import report_m2_core_dev_quality as m


class CoreDevQualityTests(unittest.TestCase):
    def setUp(self):
        self.raw = m.core.FIXTURE.read_bytes()
        self.bundle = m.strict_json(self.raw)
        self.source_contract = m.load(m.core.CONTRACT)
        self.contract = m.load(m.CONTRACT)

    def build(self, raw=None, contract=None):
        return m.build_report(self.raw if raw is None else raw, self.source_contract,
                              self.contract if contract is None else contract)

    def row(self, text='alpha beta gamma delta epsilon zeta eta theta iota kappa'):
        # Helper-only mutations never pass the formal existing-Core validator.
        row = copy.deepcopy(next(r for r in self.bundle['samples'] if r['domain'] == 'card_chain'))
        row['input']['messages'][0]['content'] = text
        return row

    def projection(self, row):
        return m.comparison_projection(row)

    def test_real_24_replay_and_identity_preservation(self):
        before = copy.deepcopy(self.bundle)
        report = self.build()
        self.assertEqual(report, self.build())
        self.assertEqual(before, self.bundle)
        self.assertEqual(self.raw, m.core.FIXTURE.read_bytes())
        self.assertEqual(len(report['samples']), 24)
        identities = {r['sample_id']: r for r in before['samples']}
        for sample in report['samples']:
            row = identities[sample['sample_id']]
            self.assertEqual(sample['input_sha256'], m.digest(row['input']))
            self.assertEqual(sample['answer_sha256'], m.digest(row['answer_candidate']))
            self.assertEqual(sample['row_sha256'], m.digest(row))
        self.assertFalse(report['formal_qualification'])
        self.assertFalse(report['source_modified'])
        self.assertEqual(report['model_calls'], 0)
        self.assertEqual(report['holdout_generated'], 0)

    def test_only_explicit_ids_and_graph_references_are_normalized(self):
        left = self.row('Content contains id=important and scope=visible')
        right = copy.deepcopy(left)
        right['sample_id'] = 'another-sample'
        right['input']['segment_id'] = 'another-segment'
        msg = right['input']['messages'][0]
        msg['message_id'], msg['evidence_id'] = 'another-message', 'another-evidence'
        right['answer_candidate']['anchor_message_ids'] = ['another-message']
        self.assertNotEqual(m.digest(left['input']), m.digest(right['input']))
        self.assertEqual(self.projection(left), self.projection(right))
        self.assertEqual(m.compare(self.projection(left), self.projection(right)), 'NORMALIZED_EXACT')
        right['input']['messages'][0]['content'] = 'Content contains id=different and scope=visible'
        self.assertNotEqual(self.projection(left), self.projection(right))

    def test_role_context_and_reference_time_are_exact_guards(self):
        left = self.row()
        for field, value in [('author_role', 'assistant'), ('context_only', True),
                             ('created_at', '2026-10-03T00:00:00Z')]:
            right = copy.deepcopy(left)
            right['input']['messages'][0][field] = value
            self.assertIsNone(m.compare(self.projection(left), self.projection(right)))
        right = copy.deepcopy(left)
        right['input']['timezone'] = 'Asia/Shanghai'
        self.assertIsNone(m.compare(self.projection(left), self.projection(right)))

    def test_message_order_and_reference_graph_are_retained(self):
        left = self.row()
        second = copy.deepcopy(left['input']['messages'][0])
        second.update(message_id='second', evidence_id='second-evidence', content='another ordered turn')
        left['input']['messages'].append(second)
        right = copy.deepcopy(left)
        right['input']['messages'].reverse()
        self.assertIsNone(m.compare(self.projection(left), self.projection(right)))
        right = copy.deepcopy(left)
        right['answer_candidate']['anchor_message_ids'] = ['second']
        self.assertIsNone(m.compare(self.projection(left), self.projection(right)))
        right['answer_candidate']['anchor_message_ids'] = ['missing']
        with self.assertRaises(m.FoundationError):
            self.projection(right)

    def test_visibility_policy_and_json_content_id_are_not_fuzzy(self):
        left = self.row('{"id":"a","scope":"visible","grant_present":true}')
        right = copy.deepcopy(left)
        for replacement in ['{"id":"b","scope":"visible","grant_present":true}',
                            '{"id":"a","scope":"hidden","grant_present":true}',
                            '{"id":"a","scope":"visible","grant_present":false}']:
            right['input']['messages'][0]['content'] = replacement
            self.assertIsNone(m.compare(self.projection(left), self.projection(right)))

    def test_utterance_candidate_id_and_anchor_positions(self):
        left = copy.deepcopy(next(r for r in self.bundle['samples'] if r['domain'] == 'utterance_card'))
        right = copy.deepcopy(left)
        right['input']['segment_id'] = right['answer_candidate']['segment_id'] = 'new-segment'
        right['input']['messages'][0]['message_id'] = 'new-message'
        item = right['answer_candidate']['items'][0]
        item['candidate_local_id'] = 'new-local-item'
        item['source_anchors'][0]['message_id'] = 'new-message'
        self.assertEqual(self.projection(left), self.projection(right))

    def test_nfkc_and_existing_nine_tenths_threshold(self):
        left = self.row('ＡＬＰＨＡ beta gamma delta epsilon zeta eta theta iota kappa')
        right = self.row('alpha beta gamma delta epsilon zeta eta theta iota kappa')
        self.assertEqual(m.compare(self.projection(left), self.projection(right)), 'NORMALIZED_EXACT')
        right['input']['messages'][0]['content'] = 'alpha beta gamma delta epsilon zeta eta theta iota'
        self.assertEqual(m.compare(self.projection(left), self.projection(right)), 'LEXICAL_NEAR')
        right['input']['messages'][0]['content'] = 'alpha beta gamma delta epsilon zeta eta theta'
        self.assertIsNone(m.compare(self.projection(left), self.projection(right)))
        self.assertEqual(self.contract['near_duplicate_threshold'],
                         m.scanner.EXPECTED_CONTRACT['near_duplicate_threshold'])

    def test_answer_candidate_scrub_nfkc_and_controls_without_echo(self):
        value = {'items': [{'claim': 'fixture.person@example.invalid',
                            'summary': 'ｐａｓｓｗｏｒｄ＝fixture-only',
                            'notes': 'safe\x01text'}]}
        flags = m.scrub_fields(value, 'answer_candidate')
        self.assertEqual(len(flags), 3)
        reasons = {reason for flag in flags for reason in flag['reason_codes']}
        self.assertTrue({'EMAIL', 'SECRET_ASSIGNMENT', 'CONTROL_CHARACTER'} <= reasons)
        rendered = m.scanner.render(flags)
        self.assertNotIn('fixture.person', rendered)
        self.assertNotIn('fixture-only', rendered)
        self.assertTrue(all(flag['field_path'].startswith('answer_candidate/') for flag in flags))

    def test_all_strings_in_both_fields_use_existing_scrub(self):
        with patch.object(m, 'scrub_fields', wraps=m.scrub_fields) as scan:
            self.build()
        self.assertEqual(scan.call_count, 48)
        self.assertEqual({call.args[1] for call in scan.call_args_list}, {'input', 'answer_candidate'})

    def test_report_uses_existing_connected_components(self):
        with patch.object(m.scanner, 'deduplicate', wraps=m.scanner.deduplicate) as dedup:
            report = self.build()
        self.assertGreater(dedup.call_count, 0)
        self.assertNotIn('removed', report)
        self.assertNotIn('curated_rows', report)

    def test_source_raw_bytes_and_policy_bindings(self):
        first = self.build()
        second = self.build(self.raw + b'\n')
        self.assertNotEqual(first['bindings']['source_raw_sha256'], second['bindings']['source_raw_sha256'])
        self.assertEqual(first['bindings']['input_revision_sha256'], second['bindings']['input_revision_sha256'])
        self.assertEqual(first['bindings']['scanner_sha256'], self.contract['scanner_sha256'])
        self.assertEqual(first['bindings']['policy_sha256'], self.contract['policy_sha256'])
        with self.assertRaises(m.FoundationError):
            m.validate_report(first, self.raw + b'\n', self.source_contract, self.contract)
        with patch.object(m, 'raw_sha', return_value='0' * 64):
            with self.assertRaises(m.FoundationError):
                self.build()

    def test_missing_changed_policy_fails_closed(self):
        for field in ['scanner_sha256', 'policy_sha256', 'near_duplicate_threshold']:
            contract = copy.deepcopy(self.contract)
            del contract[field]
            with self.assertRaises(m.FoundationError):
                self.build(contract=contract)
        contract = copy.deepcopy(self.contract)
        contract['near_duplicate_threshold']['numerator'] = 8
        with self.assertRaises(m.FoundationError):
            self.build(contract=contract)

    def test_formal_entry_rejects_unknown_structure_and_rehashed_input(self):
        for mutate in [lambda b: b.__setitem__('unknown', True),
                       lambda b: b['samples'][0]['input']['messages'][0].__setitem__('content', 'changed'),
                       lambda b: b['samples'][0].__setitem__('partition', 'QUALIFICATION')]:
            bundle = copy.deepcopy(self.bundle)
            mutate(bundle)
            bundle['revision_sha256'] = m.digest({k: v for k, v in bundle.items() if k != 'revision_sha256'})
            with self.assertRaises(m.FoundationError):
                self.build(m.scanner.render(bundle).encode('utf-8'))
        with self.assertRaises(m.FoundationError):
            self.projection({**self.row(), 'domain': 'unknown'})

    def test_invalid_json_duplicate_keys_and_nonfinite_fail_closed(self):
        for raw in [b'not json', b'{"a":1,"a":2}', b'{"a":NaN}']:
            with self.assertRaises((ValueError, m.FoundationError)):
                self.build(raw)

    def test_report_no_answer_plaintext_and_replay_tamper(self):
        report = self.build()
        rendered = m.scanner.render(report)
        for row in self.bundle['samples']:
            for message in row['input']['messages']:
                self.assertNotIn(message['content'], rendered)
        self.assertNotIn('answer_candidate":{', rendered)
        report['samples'][0]['input_sha256'] = '0' * 64
        with self.assertRaises(m.FoundationError):
            m.validate_report(report, self.raw, self.source_contract, self.contract)

    def test_cli_source_restricted_and_existing_outputs_preserved(self):
        for path in [ROOT / 'memory/manifest.json', ROOT / 'tests/fixtures/other.json',
                     ROOT.parent / 'outside.json']:
            with self.assertRaises(m.FoundationError):
                m.ordinary_path(path)
        for path in [m.core.FIXTURE, m.CONTRACT, ROOT / 'scripts/output.json']:
            with self.assertRaises(m.FoundationError):
                m.ordinary_path(path, output=True)
        stream = StringIO()
        with redirect_stdout(stream):
            code = m.main(['--input', str(ROOT / 'missing.json')])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stream.getvalue())['status'], 'FAIL_CLOSED_CORE_DEV_QUALITY_REPORT')


if __name__ == '__main__':
    unittest.main()
