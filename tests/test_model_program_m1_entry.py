import copy,importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/model-program/validate_m1_entry_bindings.py'
s=importlib.util.spec_from_file_location('m1v',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class ModelProgramM1EntryTests(unittest.TestCase):
    def test_full_binding_validator(self):
        self.assertEqual(m.main(),0)

    def test_pending_profile_cannot_be_issued(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.candidate.json')
        p=copy.deepcopy(p); p['status']='ISSUED'; p['effectful_authority_issued']=True
        good,code=m.validate_profile(p)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_PENDING_BINDING_ISSUED')

    def test_model_revision_drift_fails(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.candidate.json')
        p=copy.deepcopy(p); p['model_binding']['revision']='deadbeef'
        good,code=m.validate_profile(p)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_MODEL_BINDING')

    def test_authority_expansion_fails(self):
        p=m.load(m.BASE/'governance/ExperimentAuthorizationProfile.M1-REF-QWEN35-08B-LLAMACPP-001.candidate.json')
        p=copy.deepcopy(p); p['prohibited_operations'].remove('TRAINING')
        good,code=m.validate_profile(p)
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M1_PROFILE_AUTHORITY_EXPANSION')

if __name__=='__main__': unittest.main()
