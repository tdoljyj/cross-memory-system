import pathlib, sys, unittest

REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"/"mps"))
from mps03.mps02b_pg_gateway import PgMPS02BStore


class PgBridgeOutcome(unittest.TestCase):
    def setUp(self):
        self.store=PgMPS02BStore.__new__(PgMPS02BStore)
        self.store.user_id="00000000-0000-0000-0000-000000000001"
        self.store.authority_domain="test"
        self.store.native_principal="native"
        self.store.agent_principal="agent"
        self.store.provider_evidence_refs=[]
        self.store.provider_exact_commit=None
        self.store._session=lambda token:{"principal":"native"}
        self.store._require=lambda session,action:None
        self.store._assert_object_owner=lambda object_id:None
        self.store._read_for=lambda *args: self.fail("a write response must not read later Current")
        self.durable={"status":"committed","object_id":"obj_1","result_revision_id":"rv_1","result_adoption_id":"ad_1","receipt_id":"rc_1","outcome_digest":"digest_1"}
        self.store._json=lambda sql,variables:dict(self.durable)

    def test_create_response_replays_immutable_outcome(self):
        def committed(sql, variables):
            self.assertIn("'{\"_mps03_bootstrap\":1}'::jsonb",sql)
            self.assertIn("MPS03_CREATE_NOT_COMMITTED",sql)
            return dict(self.durable)
        self.store._json=committed
        first=self.store.create_object("session","title",{"v":1},"request-001")
        replay=self.store.create_object("session","title",{"v":1},"request-001")
        self.assertEqual(first,replay)
        self.assertEqual(first["receipt_id"],"rc_1")
        self.assertNotIn("state_stamp",first)

    def test_create_rejects_duplicate_title_source(self):
        with self.assertRaisesRegex(Exception,"title must be supplied only"):
            self.store.create_object("session","title",{"title":"title","v":1},"request-001")

    def test_confirm_response_replays_immutable_outcome(self):
        first=self.store.confirm_proposal("session","obj_1","intent_1",{"state_stamp_digest":"old"},"request-002")
        replay=self.store.confirm_proposal("session","obj_1","intent_1",{"state_stamp_digest":"old"},"request-002")
        self.assertEqual(first,replay)
        self.assertEqual(first["receipt_id"],"rc_1")
        self.assertNotIn("state_stamp",first)


if __name__=="__main__": unittest.main()
