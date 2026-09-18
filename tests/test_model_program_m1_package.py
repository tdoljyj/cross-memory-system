import importlib.util
import json
import pathlib
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/model-program/validate_m1_package_profile.py'
s=importlib.util.spec_from_file_location('v',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class M1PackageProfileTests(unittest.TestCase):
    def test_full_validator(self):
        self.assertEqual(m.main(),0)

    def test_profile_is_package_only(self):
        p=json.loads((ROOT/'development/contracts/model-program/m1/governance/ExperimentAuthorizationProfile.M1-PKG-QWEN35-08B-002.issued.json').read_text(encoding='utf-8'))
        self.assertEqual(p['authority_effect'],'M1-05_PACKAGE_CONVERSION_AND_QUANTIZATION_ONLY')
        self.assertIn('MODEL_INFERENCE',p['prohibited_operations'])
        self.assertIn('MODEL_EVALUATION',p['prohibited_operations'])
        self.assertIn('QUALITY_RANKING',p['prohibited_operations'])
        self.assertEqual(p['budget_ceiling']['max_attempts'],1)
        self.assertEqual(p['network_budget_accounting']['method'],'CONSERVATIVE_AT_REST_UPPER_BOUND')
        self.assertEqual(p['network_budget_accounting']['install_mode'],'PIP_DOWNLOAD_THEN_OFFLINE_NO_INDEX_INSTALL')
        self.assertTrue(p['network_budget_accounting']['fail_closed'])

    def test_profile001_closed_without_attempt(self):
        c=json.loads((ROOT/'development/contracts/model-program/m1/evidence/M1PackageProfile001PreExecutionCloseout_20260918.json').read_text(encoding='utf-8'))
        self.assertEqual(c['attempt_accounting']['attempts_used'],0)
        self.assertFalse(c['execution_observation']['process_started'])
        self.assertFalse(c['execution_observation']['conversion_performed'])

    def test_matrix_defers_quality_selection(self):
        p=json.loads((ROOT/'development/contracts/model-program/m1/package/PackageVariantMatrix.v1.0.1.json').read_text(encoding='utf-8'))
        self.assertTrue(p['m1_06_required_before_quality_selection'])
        self.assertEqual([x['variant_id'] for x in p['variants']],['bf16','q8_0','q4_0','q4_k_m'])

    def test_runtime_successor_is_explicit(self):
        p=json.loads((ROOT/'development/contracts/model-program/m1/package/RuntimePackageSelection.v1.0.1.json').read_text(encoding='utf-8'))
        self.assertEqual(p['predecessor_runtime']['commit'],'bdcbaaf6e7520b68c8c60ff724c67409970d70e1')
        self.assertEqual(p['successor_runtime']['commit'],'8ed1a55efcd7424d2c592f6cbc9f97756db1d74d')
        self.assertFalse(p['successor_delta_review']['qwen35_runtime_core_changed'])

if __name__=='__main__':
    unittest.main()
