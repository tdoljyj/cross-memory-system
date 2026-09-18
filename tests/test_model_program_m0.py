import importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/model-program/validate_m0_foundation.py'
s=importlib.util.spec_from_file_location('m0v',P);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class T(unittest.TestCase):
    def test_full_validator(self): self.assertEqual(m.main(),0)
if __name__=='__main__': unittest.main()
