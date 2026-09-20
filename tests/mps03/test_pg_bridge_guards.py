import pathlib, sys, unittest
REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"/"mps"))
from mps03.mps02b_pg_gateway import PgMPS02BStore, EXPECTED_NONPROD_TARGET

KW=dict(dsn="postgresql://invalid",user_id="00000000-0000-0000-0000-000000000001",authority_domain="d",native_principal="n",agent_principal="a",native_secret="ns",agent_secret="as")
class PgBridgeGuards(unittest.TestCase):
    def test_rejects_any_target_other_than_exact_nonprod(self):
        with self.assertRaisesRegex(RuntimeError,"target guard failed"):
            PgMPS02BStore(**KW,target_id="production/something",allow_nonprod_write="MPS03_NONPROD_WRITE_APPROVED")
    def test_requires_explicit_nonprod_write_guard(self):
        with self.assertRaisesRegex(RuntimeError,"write guard"):
            PgMPS02BStore(**KW,target_id=EXPECTED_NONPROD_TARGET,allow_nonprod_write="")
if __name__=="__main__": unittest.main()
