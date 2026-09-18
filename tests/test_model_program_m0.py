import importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/model-program/validate_m0_foundation.py'
s=importlib.util.spec_from_file_location('m0v',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class ModelProgramM0Tests(unittest.TestCase):
    def test_full_candidate_validator(self): self.assertEqual(m.main(),0)
    def test_each_negative_is_rejected(self):
        cases=m.load(ROOT/'tests/fixtures/model-program-m0/negative-fixtures.json')
        for c in cases['negative_cases']:
            with self.subTest(case=c['id']):
                good,code=m.VALIDATORS[c['validator']](c['input'])
                self.assertFalse(good); self.assertEqual(code,c['expected_error'])
    def test_each_positive_is_accepted(self):
        cases=m.load(ROOT/'tests/fixtures/model-program-m0/negative-fixtures.json')
        for c in cases['positive_cases']:
            with self.subTest(case=c['id']):
                good,code=m.VALIDATORS[c['validator']](c['input'])
                self.assertTrue(good,code)
if __name__=='__main__': unittest.main()
