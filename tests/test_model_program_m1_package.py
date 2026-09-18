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

    def test_profile002_pass_closeout_is_consumed(self):
        c=json.loads((ROOT/'development/contracts/model-program/m1/evidence/M1PackageProfile002ExecutionCloseout_20260918.json').read_text(encoding='utf-8'))
        self.assertEqual(c['result'],'PASS / CLUED_MODEL_M1_PKG_PROFILE_002_VARIANTS_PREPARED_AND_INTEGRITY_VERIFIED')
        self.assertEqual(c['attempt_accounting']['attempts_used'],1)
        self.assertFalse(c['attempt_accounting']['retry_under_same_profile_allowed'])
        self.assertEqual(len(c['variants']),4)
        self.assertTrue(all(x['gguf_magic_verified'] for x in c['variants']))
        self.assertTrue(c['external_integrity_verification']['all_four_variant_sha256_match_manifest'])
        self.assertFalse(c['effects']['model_inference_performed'])
        self.assertFalse(c['effects']['model_evaluation_performed'])
        self.assertFalse(c['effects']['quality_selection_performed'])

    def test_generated_matrix_is_integrity_verified_but_unranked(self):
        p=json.loads((ROOT/'development/contracts/model-program/m1/package/PackageVariantMatrix.v1.0.2.json').read_text(encoding='utf-8'))
        self.assertEqual(p['status'],'GENERATED_AND_INTEGRITY_VERIFIED / QUALITY_UNRANKED')
        self.assertFalse(p['quality_selection']['performed'])
        self.assertIsNone(p['quality_selection']['winner'])
        self.assertEqual(p['quality_selection']['required_stage'],'M1-06')
        self.assertTrue(all(x['package_status']=='GENERATED_INTEGRITY_VERIFIED' for x in p['variants']))
        self.assertTrue(all(x['quality_status']=='NOT_EVALUATED' for x in p['variants']))

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
