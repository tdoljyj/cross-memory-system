import pathlib, subprocess, sys, unittest
from unittest.mock import patch
REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"/"mps"))
from mps03.common import ProtocolError, require_secret_namespace, NATIVE_GATEWAY_PREFIX, AGENT_GATEWAY_PREFIX, NATIVE_ACCESS_PREFIX, AGENT_ACCESS_PREFIX
from mps03.mps02b_pg_gateway import PgMPS02BStore, EXPECTED_NONPROD_TARGET, _assert_loopback_host, _assert_nonprod_dsn

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
    def test_entry_authority_requires_distinct_principals_and_secrets(self):
        dsn="postgresql://postgres:secret@db.uscrdifznmlvczcekqpw.supabase.co:5432/postgres?sslmode=verify-full"
        base={**KW,"dsn":dsn,"native_secret":NATIVE_GATEWAY_PREFIX+"n"*32,"agent_secret":AGENT_GATEWAY_PREFIX+"a"*32}
        for override in ({"agent_secret":NATIVE_GATEWAY_PREFIX+"n"*32},{"agent_secret":""},{"agent_principal":"n"}):
            with self.subTest(override=override), self.assertRaises(RuntimeError):
                PgMPS02BStore(**{**base,**override},target_id=EXPECTED_NONPROD_TARGET,
                                allow_nonprod_write="MPS03_NONPROD_WRITE_APPROVED")
    def test_all_four_credential_namespaces_are_disjoint(self):
        prefixes=(NATIVE_GATEWAY_PREFIX,AGENT_GATEWAY_PREFIX,NATIVE_ACCESS_PREFIX,AGENT_ACCESS_PREFIX)
        self.assertEqual(len(set(prefixes)),4)
        for expected in prefixes:
            require_secret_namespace(expected+"x"*32,expected,"test secret")
            for wrong in prefixes:
                if wrong != expected:
                    with self.subTest(expected=expected,wrong=wrong), self.assertRaises(RuntimeError):
                        require_secret_namespace(wrong+"x"*32,expected,"test secret")
    def test_gateway_only_binds_to_loopback(self):
        for host in ("127.0.0.1","localhost","::1"):
            _assert_loopback_host(host)
        for host in ("0.0.0.0","192.0.2.4","example.test"):
            with self.subTest(host=host), self.assertRaisesRegex(RuntimeError,"loopback"):
                _assert_loopback_host(host)
    def test_database_timeout_does_not_expose_connection_secret(self):
        store=PgMPS02BStore.__new__(PgMPS02BStore)
        store.dsn="postgresql://postgres:private-password@db.uscrdifznmlvczcekqpw.supabase.co/postgres"
        def timeout(command,**kwargs):
            self.assertNotIn("private-password",str(command))
            self.assertEqual(kwargs["env"]["PGPASSWORD"],"private-password")
            raise subprocess.TimeoutExpired(command,30)
        with patch("mps03.mps02b_pg_gateway.subprocess.run",side_effect=timeout):
            with self.assertRaises(ProtocolError) as caught:
                store._psql("select 1")
        self.assertEqual(caught.exception.status,503)
        self.assertNotIn("private-password",str(caught.exception.as_dict()))
    def test_foreign_create_replay_maps_to_not_found(self):
        store=PgMPS02BStore.__new__(PgMPS02BStore)
        store.dsn="postgresql://postgres:private-password@db.uscrdifznmlvczcekqpw.supabase.co/postgres"
        failed=subprocess.CompletedProcess(args=["psql"],returncode=3,stdout="",stderr="ERROR: OBJECT_NOT_FOUND")
        with patch("mps03.mps02b_pg_gateway.subprocess.run",return_value=failed):
            with self.assertRaises(ProtocolError) as caught:
                store._psql("select 1")
        self.assertEqual((caught.exception.code,caught.exception.status),("OBJECT_NOT_FOUND",404))
    def test_malformed_confirmation_stamp_is_client_error(self):
        store=PgMPS02BStore.__new__(PgMPS02BStore)
        store.sessions={"native-session":{"principal":"native","entry_kind":"NATIVE"}}
        store.native_principal="native"
        store.agent_principal="agent"
        with self.assertRaises(ProtocolError) as caught:
            store.confirm_proposal("native-session","object-1","proposal-1",["bad"],"request-123")
        self.assertEqual(caught.exception.code,"STATE_STAMP_REQUIRED")
if __name__=="__main__": unittest.main()
