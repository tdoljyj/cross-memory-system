import pathlib, sys, unittest
REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"/"mps"))
from mps03.common import ProtocolError
from mps03.mps02b_pg_gateway import PgMPS02BStore, EXPECTED_NONPROD_TARGET, _assert_nonprod_dsn

KW=dict(dsn="postgresql://invalid",user_id="00000000-0000-0000-0000-000000000001",authority_domain="d",native_principal="n",agent_principal="a",native_secret="ns",agent_secret="as")
class PgBridgeGuards(unittest.TestCase):
    def test_rejects_any_target_other_than_exact_nonprod(self):
        with self.assertRaisesRegex(RuntimeError,"target guard failed"):
            PgMPS02BStore(**KW,target_id="production/something",allow_nonprod_write="MPS03_NONPROD_WRITE_APPROVED")
    def test_requires_explicit_nonprod_write_guard(self):
        with self.assertRaisesRegex(RuntimeError,"write guard"):
            PgMPS02BStore(**KW,target_id=EXPECTED_NONPROD_TARGET,allow_nonprod_write="")
    def test_right_label_cannot_authorize_wrong_connection(self):
        with self.assertRaisesRegex(RuntimeError,"connection target rejected"):
            PgMPS02BStore(**KW,target_id=EXPECTED_NONPROD_TARGET,allow_nonprod_write="MPS03_NONPROD_WRITE_APPROVED")
    def test_accepts_only_verified_target_uri_forms(self):
        _assert_nonprod_dsn("postgresql://postgres:secret@db.uscrdifznmlvczcekqpw.supabase.co:5432/postgres?sslmode=verify-full")
        _assert_nonprod_dsn("postgresql://postgres.uscrdifznmlvczcekqpw:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full")
        for dsn in (
            "postgresql://postgres:secret@db.productionref.supabase.co:5432/postgres?sslmode=verify-full",
            "postgresql://postgres.otherref:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full",
            "postgresql://postgres:secret@db.uscrdifznmlvczcekqpw.supabase.co:5432/postgres?sslmode=verify-full&hostaddr=127.0.0.1",
            "postgresql://postgres:secret@db.uscrdifznmlvczcekqpw.supabase.co:5432/postgres?sslmode=require",
            "postgresql://postgres:secret@db.uscrdifznmlvczcekqpw.supabase.co:6543/postgres?sslmode=verify-full",
        ):
            with self.subTest(dsn=dsn), self.assertRaises(RuntimeError):
                _assert_nonprod_dsn(dsn)
    def test_proposal_rejects_non_object_body_before_database_write(self):
        store=PgMPS02BStore.__new__(PgMPS02BStore)
        store.sessions={"agent-session":{"principal":"agent","entry_kind":"THIRD_PARTY_AGENT_HOST"}}
        store.agent_principal="agent"
        store.native_principal="native"
        with self.assertRaises(ProtocolError) as rejected:
            store.create_proposal("agent-session","object-1",["not an object"],{})
        self.assertEqual(rejected.exception.code,"JSON_OBJECT_REQUIRED")
if __name__=="__main__": unittest.main()
