import importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/model-program/validate_m0_foundation.py'
s=importlib.util.spec_from_file_location('m0v',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class ModelProgramM0Tests(unittest.TestCase):
    def test_full_candidate_validator(self):
        self.assertEqual(m.main(),0)

    def test_each_negative_is_rejected(self):
        cases=m.load(ROOT/'tests/fixtures/model-program-m0/negative-fixtures.json')
        for c in cases['negative_cases']:
            with self.subTest(case=c['id']):
                good,code=m.run_case(c)
                self.assertFalse(good)
                self.assertEqual(code,c['expected_error'])

    def test_each_positive_is_accepted(self):
        cases=m.load(ROOT/'tests/fixtures/model-program-m0/negative-fixtures.json')
        for c in cases['positive_cases']:
            with self.subTest(case=c['id']):
                good,code=m.run_case(c)
                self.assertTrue(good,code)

    def test_manifest_surface_is_closed(self):
        manifest=m.load(m.BASE/'SHA256SUMS.json')
        self.assertEqual(set(x['path'] for x in manifest['files']),m.expected_manifest_paths())

    def test_gate_definition_set_digest_is_exact(self):
        registry=m.load(m.BASE/'registries/GateDefinitionRegistry.json')
        basis=[{k:d[k] for k in ('gate_id','definition_version','content_digest','object_type')} for d in registry['gate_definitions']]
        self.assertEqual(m.object_digest(basis),registry['gate_definition_set_digest'])

    def test_unknown_validator_fails_closed(self):
        good,code=m.run_case({'validator':'does_not_exist','input':{}})
        self.assertFalse(good)
        self.assertEqual(code,'CLUED_MODEL_M0_UNKNOWN_VALIDATOR')

if __name__=='__main__': unittest.main()
