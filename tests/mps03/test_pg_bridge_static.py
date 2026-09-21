import inspect, pathlib, sys, unittest
REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/"development"/"mps"))
from mps03 import mps02b_pg_gateway as pg

class PgBridgeStaticBinding(unittest.TestCase):
    def test_exact_formal_primitives_are_reused(self):
        src=inspect.getsource(pg)
        for name in [
            "mps_issue_context_pack",
            "mps_register_change_set",
            "mps_issue_mutation_intent",
            "mps_compute_request_fingerprint",
            "mps_commit_mutation",
        ]:
            self.assertIn(name,src)
        self.assertEqual(pg.EXPECTED_NONPROD_TARGET,"clued-auth-test/uscrdifznmlvczcekqpw")

    def test_read_surfaces_recheck_resource_action_authority(self):
        for method in [pg.PgMPS02BStore.list_objects,pg.PgMPS02BStore.list_proposals,pg.PgMPS02BStore.history]:
            self.assertIn("_read_for",inspect.getsource(method))

    def test_pg_create_uses_formal_durable_request_path(self):
        src=inspect.getsource(pg.PgMPS02BStore.create_object)
        for name in [
            "mps_issue_context_pack",
            "mps_register_change_set",
            "mps_issue_mutation_intent",
            "mps_compute_request_fingerprint",
            "mps_commit_mutation",
        ]:
            self.assertIn(name,src)
        self.assertIn("clued-mps-request:",src)
        self.assertIn("'operation','create'",src)
        self.assertIn("mps03_create_bootstrap",src)
        self.assertIn("v_existing_content is distinct from v_in.content",src)
        self.assertIn("IDEMPOTENCY_CONFLICT",src)
        self.assertNotIn("creation_request_id",src)

    def test_provider_context_is_server_bound_for_every_pack_issue(self):
        src=inspect.getsource(pg.PgMPS02BStore)
        self.assertNotIn("'[]'::jsonb,null",src)
        self.assertGreaterEqual(src.count("_j('evidence_refs')"),4)
        self.assertGreaterEqual(src.count("_t('provider_commit')"),4)
        agent_src=(REPO/"development"/"mps"/"mps03"/"agent_host_entry.py").read_text(encoding="utf-8")
        self.assertNotIn("provider_exact_commit",agent_src)
        self.assertNotIn("provenance_evidence_refs",agent_src)

    def test_pg_gateway_uses_transport_only_handler(self):
        src=inspect.getsource(pg)
        self.assertIn("gateway_http import Handler",src)
        self.assertNotIn("canonical_gateway import Handler",src)

if __name__=="__main__": unittest.main()
