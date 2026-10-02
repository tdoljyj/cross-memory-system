import copy
import json
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
        self.assertIn('grant_present=false', self.b['samples'][-1]['input']['messages'][0]['content'])
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

    def test_cli_formal_gate_and_missing_file(self):
        script = ROOT / 'scripts/model-program/validate_m2_core_synthetic_pilot.py'
        for options in (['--require-formal-gold'], ['--bundle', str(ROOT/'does-not-exist.json')]):
            result = subprocess.run([sys.executable, '-B', str(script), *options], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['status'], 'FAIL_CLOSED_CORE_DEV_CANDIDATE')


if __name__ == '__main__':
    unittest.main()
