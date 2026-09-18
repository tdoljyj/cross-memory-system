import copy,importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/model-program/validate_m1_entry_bindings.py'
s=importlib.util.spec_from_file_location('m1v',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class ModelProgramM1EntryTests(unittest.TestCase):
    def test_bound_downloader_compiles(self):
        p=ROOT/'scripts/model-program/m1_download_exact_hf_snapshot.py'
        compile(p.read_text(encoding='utf-8'),str(p),'exec')

    def test_full_binding_validator(self):
        self.assertEqual(m.main(),0)

    def test_pending_profile_cannot_be_issued(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.candidate.json')
        p=copy.deepcopy(p); p['status']='ISSUED'; p['effectful_authority_issued']=True
        good,code=m.validate_candidate_profile(p)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_PENDING_BINDING_ISSUED')

    def test_profile001_closeout_is_consumed(self):
        c=m.load(m.BASE/'evidence/M1ExperimentProfile001ExecutionCloseout_20260918.json')
        self.assertEqual(c['attempt_accounting']['attempts_used'],1)
        self.assertFalse(c['attempt_accounting']['retry_under_same_profile_allowed'])
        self.assertEqual(c['effects']['network_model_download_bytes'],0)

    def test_profile002_is_accepted(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-002.issued.json')
        good,code=m.validate_issued_profile(p,m.PROFILE002_CODE_COMMIT,m.PROFILE002_SCRIPT_BLOB)
        self.assertTrue(good,code)

    def test_profile002_closeout_is_consumed(self):
        c=m.load(m.BASE/'evidence/M1ExperimentProfile002ExecutionCloseout_20260918.json')
        self.assertFalse(c['attempt_accounting']['retry_under_same_profile_allowed'])
        self.assertEqual(c['result'],'FAIL / CLUED_MODEL_M1_PROFILE_002_CONCURRENT_DUPLICATE_WRITE_INVALIDATED_SNAPSHOT')

    def test_profile003_is_accepted(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-003.issued.json')
        good,code=m.validate_issued_profile(p,m.PROFILE003_CODE_COMMIT,m.PROFILE003_SCRIPT_BLOB)
        self.assertTrue(good,code)
        self.assertEqual(p['attempt_control'],'ONE_SHOT_EXCLUSIVE_LOCK / NEW_OUTPUT_DIR / ATOMIC_FILE_REPLACE')

    def test_profile003_closeout_is_consumed(self):
        c=m.load(m.BASE/'evidence/M1ExperimentProfile003ExecutionCloseout_20260918.json')
        self.assertEqual(c['result'],'PASS / CLUED_MODEL_M1_PROFILE_003_DOWNLOAD_AND_INTEGRITY_ACCEPTED')
        self.assertEqual(c['snapshot']['source_file_count'],13)
        self.assertEqual(c['snapshot']['weight']['sha256'],'04b1c301231dd422b8860db31311ab2721511346a32cb1e079c4c4e5f1fe4696')
        self.assertEqual(c['integrity_verification']['downloader_internal_independent_rehash'],'PASS')
        self.assertEqual(c['integrity_verification']['reviewer_external_rehash'],'PASS')
        self.assertFalse(c['attempt_accounting']['retry_under_same_profile_allowed'])
        self.assertEqual(c['m1_task_effect']['M1-03'],'COMPLETED')

    def test_model_revision_drift_fails(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-003.issued.json')
        p=copy.deepcopy(p); p['model_binding']['revision']='deadbeef'
        good,code=m.validate_issued_profile(p,m.PROFILE003_CODE_COMMIT,m.PROFILE003_SCRIPT_BLOB)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_MODEL_BINDING')

    def test_authority_expansion_fails(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-003.issued.json')
        p=copy.deepcopy(p); p['prohibited_operations'].remove('TRAINING')
        good,code=m.validate_issued_profile(p,m.PROFILE003_CODE_COMMIT,m.PROFILE003_SCRIPT_BLOB)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION')

    def test_execution_code_drift_fails(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-003.issued.json')
        p=copy.deepcopy(p); p['execution_code']['commit']='deadbeef'
        good,code=m.validate_issued_profile(p,m.PROFILE003_CODE_COMMIT,m.PROFILE003_SCRIPT_BLOB)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_EXECUTION_CODE_BINDING')

    def test_device_binding_drift_fails(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-003.issued.json')
        p=copy.deepcopy(p); p['device_binding']['device_name']='OTHER'
        good,code=m.validate_issued_profile(p,m.PROFILE003_CODE_COMMIT,m.PROFILE003_SCRIPT_BLOB)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_DEVICE_BINDING')

if __name__=='__main__': unittest.main()
