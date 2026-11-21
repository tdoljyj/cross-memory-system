import copy
import json
import hashlib
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/model-program'))
import validate_m2_core_synthetic_pilot as core
from validate_m2_dataset_foundation import FoundationError, digest, load


class CorePilotTests(unittest.TestCase):
    def setUp(self):
        self.c = load(core.CONTRACT)
        self.b = load(core.FIXTURE)

    def rehash(self, b):
        for row in b['samples']:
            row['evidence']['input_sha256'] = digest(row['input'])
            row['evidence']['answer_sha256'] = digest(row['answer_candidate'])
            row['evidence']['source_sha256'] = digest(row['source'])
        b['revision_sha256'] = digest({k:v for k,v in b.items() if k != 'revision_sha256'})

    def reject(self, b=None, c=None):
        with self.assertRaises(FoundationError):
            core.validate(self.b if b is None else b, self.c if c is None else c)

    def test_regeneration_and_balanced_development(self):
        self.assertEqual(core.generate(self.c), self.b)
        result = core.validate(self.b, self.c)
        self.assertEqual(result['domain_counts'], {d:6 for d in core.DOMAINS})
        self.assertEqual(result['holdout_generated'], 0)
        self.assertEqual(result['qualification_generated'], 0)

    def test_formal_gold_never_available(self):
        with self.assertRaises(FoundationError):
            core.validate(self.b, self.c, require_formal=True)

    def test_no_heldout_payload_or_seed_surface(self):
        for material in ({'seed': 1}, {'answers': []}, {'samples': []}):
            b = copy.deepcopy(self.b); b['heldout_material'] = material
            self.reject(b)
        c = copy.deepcopy(self.c); c['materialization']['heldout_seed_or_answer_material'] = 42
        self.reject(c=c)

    def test_qualification_and_holdout_relabel_rejected(self):
        for partition in ('QUALIFICATION','FINAL_HOLDOUT','TRAINING'):
            b = copy.deepcopy(self.b); b['samples'][0]['partition'] = partition
            self.rehash(b); self.reject(b)

    def test_duplicates_and_missing_rows_rejected(self):
        b = copy.deepcopy(self.b); b['samples'][1] = copy.deepcopy(b['samples'][0])
        self.rehash(b); self.reject(b)
        b = copy.deepcopy(self.b); b['samples'].pop(); self.reject(b)

    def test_source_rule_or_license_tamper_even_rehashed(self):
        for field, value in (('source_class','A'),('origin','PAID_MODEL'),('private_data_imported',True),
                             ('rule_revision','unknown'),('license_scope','TRAINING')):
            b = copy.deepcopy(self.b); b['samples'][0]['source'][field] = value
            self.rehash(b); self.reject(b)

    def test_independent_review_or_role_cannot_be_faked(self):
        b = copy.deepcopy(self.b); b['samples'][0]['review']['status'] = 'INDEPENDENT_PASS'
        self.rehash(b); self.reject(b)
        c = copy.deepcopy(self.c); c['role_slots']['holdout_custodian']['authenticated_subject_ref'] = 'same-agent'
        self.reject(c=c)

    def test_malformed_input_or_output(self):
        b = copy.deepcopy(self.b); b['samples'][0]['input']['messages'][0]['author_role'] = 'admin'
        self.reject(b)
        b = copy.deepcopy(self.b); b['samples'][0]['answer_candidate']['items'][0]['item_type'] = 'knowledge'
        self.reject(b)

    def test_exact_anchor_and_context_only_rejected(self):
        b = copy.deepcopy(self.b); b['samples'][0]['answer_candidate']['items'][0]['source_anchors'][0]['exact_quote'] = 'invented'
        self.rehash(b); self.reject(b)
        b = copy.deepcopy(self.b); b['samples'][0]['input']['messages'][0]['context_only'] = True
        self.rehash(b); self.reject(b)

    def test_chain_direction_and_execution_tamper(self):
        for field, val in (('suggested_before','card_unknown'),('execute',True)):
            b = copy.deepcopy(self.b); b['samples'][6]['answer_candidate'][field] = val
            self.rehash(b); self.reject(b)

    def test_imprint_conflict_and_source_claim_preserved(self):
        b = copy.deepcopy(self.b); b['samples'][13]['answer_candidate']['conflict'] = False
        self.rehash(b); self.reject(b)
        b = copy.deepcopy(self.b); b['samples'][12]['answer_candidate']['external_truth_verified'] = True
        self.rehash(b); self.reject(b)

    def test_context_unknown_scope_and_grant_never_authorizes(self):
        for row in self.b['samples'][19:]:
            self.assertFalse(row['answer_candidate']['candidate_eligible'])
            self.assertFalse(row['answer_candidate']['execute'])
        self.assertFalse(json.loads(self.b['samples'][-1]['input']['messages'][0]['content'])['grant_present'])
        b = copy.deepcopy(self.b); b['samples'][-1]['answer_candidate']['candidate_eligible'] = True
        self.rehash(b); self.reject(b)

    def test_closed_contract_and_wrong_source_pins(self):
        c = copy.deepcopy(self.c); c['source_bindings'][0]['sha256'] = '0'*64
        self.reject(c=c)
        c = copy.deepcopy(self.c); c['source_bindings'][0]['path'] = '../outside'
        self.reject(c=c)
        c = copy.deepcopy(self.c); c['planned_counts']['context']['FINAL_HOLDOUT'] = 6.0
        self.reject(c=c)
        b = copy.deepcopy(self.b); b['seed'] = 1
        self.reject(b)

    def test_authority_refs_revision_and_contract_tamper(self):
        for field in core.AUTHORITY:
            b = copy.deepcopy(self.b); b['authority'][field] = 'ISSUED'
            self.rehash(b); self.reject(b)
        b = copy.deepcopy(self.b); b['revision_sha256'] = '0'*64; self.reject(b)
        b = copy.deepcopy(self.b); b['contract_sha256'] = '0'*64; self.reject(b)

    def test_context_target_policy_is_visible_and_bound(self):
        for row in self.b['samples'][18:]:
            resource, policy = (json.loads(m['content']) for m in row['input']['messages'])
            self.assertEqual(policy['expected_scope'], 'synthetic-project-A')
            self.assertEqual(digest(policy), self.c['context_policy_sha256'])
            self.assertEqual(row['answer_candidate'], core.context_answer(row['input'], digest(policy)))
            self.assertFalse(row['answer_candidate']['live_authorization_checked'])
        row = copy.deepcopy(self.b['samples'][21])
        resource = json.loads(row['input']['messages'][0]['content'])
        self.assertEqual(resource['scope'], 'synthetic-project-B')
        resource['scope'] = 'synthetic-project-A'
        row['input']['messages'][0]['content'] = json.dumps(resource)
        self.assertTrue(core.context_answer(row['input'], self.c['context_policy_sha256'])['candidate_eligible'])

    def test_context_missing_or_tampered_visible_policy_rejected(self):
        b = copy.deepcopy(self.b)
        b['samples'][18]['input']['messages'].pop()
        self.rehash(b); self.reject(b)
        for key, value in (('expected_scope', 'synthetic-project-B'), ('require_declared_grant', False)):
            b = copy.deepcopy(self.b)
            msg = b['samples'][18]['input']['messages'][1]
            policy = json.loads(msg['content']); policy[key] = value
            msg['content'] = json.dumps(policy)
            self.rehash(b); self.reject(b)
            c = copy.deepcopy(self.c); c['context_policy_sha256'] = digest(policy)
            self.reject(b, c)

    def test_imprint_conflict_requires_visible_single_value_premise(self):
        for n, row in enumerate(self.b['samples'][12:18], 1):
            premise, a, b = (json.loads(m['content']) for m in row['input']['messages'])
            self.assertEqual(premise['cardinality'], 'SINGLE')
            for key in ('subject', 'attribute', 'effective_at'):
                self.assertEqual(a[key], premise[key]); self.assertEqual(b[key], premise[key])
            self.assertEqual(row['answer_candidate']['conflict'], n % 2 == 0)
            self.assertEqual(row['answer_candidate']['ambiguities'], [])

    def test_imprint_unestablished_premise_preserves_ambiguity_and_claims(self):
        original = self.b['samples'][13]['input']
        variants = []
        missing = copy.deepcopy(original); missing['messages'].pop(0); variants.append(missing)
        multiple = copy.deepcopy(original)
        premise = json.loads(multiple['messages'][0]['content']); premise['cardinality'] = 'MULTIPLE'
        multiple['messages'][0]['content'] = json.dumps(premise); variants.append(multiple)
        for key, value in (('subject', 'another-subject'), ('attribute', 'another-attribute'),
                           ('effective_at', '2026-10-03T00:00:00Z')):
            segment = copy.deepcopy(original)
            claim = json.loads(segment['messages'][2]['content']); claim[key] = value
            segment['messages'][2]['content'] = json.dumps(claim); variants.append(segment)
        for segment in variants:
            answer = core.imprint_answer(segment)
            self.assertIsNone(answer['conflict'])
            self.assertTrue(answer['ambiguities'])
            self.assertEqual(answer['claims'], [m['content'] for m in segment['messages'][-2:]])
            self.assertFalse(answer['external_truth_verified']); self.assertFalse(answer['canonical_write'])

    def test_utterance_semantic_uncertainty_separate_from_review_status(self):
        for n, row in enumerate(self.b['samples'][:6], 1):
            item = row['answer_candidate']['items'][0]
            self.assertEqual(item['uncertainties'], ['更轻的呈现含义未确定'] if n == 6 else [])
            self.assertEqual(item['confidence'], 0.5)
            self.assertEqual(row['review']['status'], 'AUTHOR_ONLY_PENDING_INDEPENDENT_REVIEW')
            self.assertEqual(row['review']['confidence_semantics'],
                             'EXISTING_0_5_SCHEMA_PLACEHOLDER_UNCALIBRATED_NOT_MODEL_ESTIMATE')

    def test_production_status_or_missing_semantic_uncertainty_rejected(self):
        for index, uncertainties in ((0, ['未独立复核']), (5, [])):
            b = copy.deepcopy(self.b)
            b['samples'][index]['answer_candidate']['items'][0]['uncertainties'] = uncertainties
            self.rehash(b); self.reject(b)

    def test_rule_binding_hashes_actual_reproducible_implementation_bytes(self):
        binding = self.c['rule_implementation']
        self.assertEqual(binding['path'], 'scripts/model-program/validate_m2_core_synthetic_pilot.py')
        self.assertEqual(binding['sha256'], hashlib.sha256((ROOT / binding['path']).read_bytes()).hexdigest())
        for row in self.b['samples']:
            self.assertEqual(row['source']['rule_implementation'], binding)
            self.assertEqual(row['evidence']['rule_sha256'], binding['sha256'])
            self.assertNotEqual(row['evidence']['rule_sha256'], digest(row['source']['rule_revision']))
        self.assertNotIn(binding['sha256'], (ROOT / binding['path']).read_text(encoding='utf-8'))

    def test_missing_or_mismatched_rule_implementation_rejected(self):
        for key, value in (('path', '../outside.py'), ('revision', 'unknown'), ('sha256', '0'*64)):
            c = copy.deepcopy(self.c); c['rule_implementation'][key] = value
            self.reject(c=c)
        c = copy.deepcopy(self.c); del c['rule_implementation']; self.reject(c=c)
        b = copy.deepcopy(self.b); b['samples'][0]['evidence']['rule_sha256'] = '0'*64
        self.rehash(b); self.reject(b)
        b = copy.deepcopy(self.b); b['samples'][0]['source']['rule_implementation']['sha256'] = '0'*64
        self.rehash(b); self.reject(b)

    def test_cli_formal_gate_and_missing_file(self):
        script = ROOT / 'scripts/model-program/validate_m2_core_synthetic_pilot.py'
        for options in (['--require-formal-gold'], ['--bundle', str(ROOT/'does-not-exist.json')]):
            result = subprocess.run([sys.executable, '-B', str(script), *options], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['status'], 'FAIL_CLOSED_CORE_DEV_CANDIDATE')


if __name__ == '__main__':
    unittest.main()
