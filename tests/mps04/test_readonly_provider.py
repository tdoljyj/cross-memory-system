"""Candidate-only D-007 checks; not a live G4/G6 acceptance result."""
import pathlib
import sys
import unittest
from urllib.error import HTTPError

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "development" / "mps"))

from mps03.common import ProtocolError
from mps03.gateway_http import Handler
from mps03.mps02b_pg_gateway import PgMPS02BStore, EXPECTED_PROVIDER_REPOSITORY
from mps03.native_entry import NativeHandler
from mps04.github_readonly import GitHubReadOnlyProvider, ProviderUnavailable

A = "a" * 40
B = "b" * 40
OID = "obj_test"


class ProviderCandidate(unittest.TestCase):
    def provider(self, head=B, comparison=None):
        calls = []

        def api_get(path):
            calls.append(path)
            if "/branches/" in path:
                return {"commit": {"sha": head}}
            return comparison if comparison is not None else {
                "status": "ahead", "files": [{"filename": "src/<changed>.py"}]
            }

        return GitHubReadOnlyProvider(EXPECTED_PROVIDER_REPOSITORY, "main", api_get=api_get), calls

    def test_d007_reports_exact_a_and_b_source_without_adoption(self):
        provider, calls = self.provider()
        observed = provider.observe(A)
        self.assertEqual(observed["clued_adopted_exact_commit"], A)
        self.assertEqual(observed["provider_exact_commit"], B)
        self.assertTrue(observed["drift"])
        self.assertEqual(observed["ancestry"], "ahead")
        self.assertEqual(observed["persistence"], "NOT_REGISTERED_CANDIDATE_ONLY")
        self.assertFalse(observed["clued_current_changed"])
        self.assertEqual(calls, [
            "/repos/tdoljyj/cross-memory-system/branches/main",
            f"/repos/tdoljyj/cross-memory-system/compare/{A}...{B}",
        ])
        current = {"body": {"repository": EXPECTED_PROVIDER_REPOSITORY,
                            "adopted_exact_commit": A}, "adoption_id": "adopt_a"}
        observed["clued_adoption_id"] = "adopt_a"
        view = NativeHandler.__new__(NativeHandler)
        view.client = type("Client", (), {"provider_observation": lambda self, oid: observed})()
        panel = view._provider_panel(OID, current)
        self.assertIn(A, panel)
        self.assertIn(B, panel)
        self.assertIn("No change was adopted automatically", panel)
        self.assertIn("View exact source", panel)
        self.assertIn("&lt;changed&gt;", panel)
        self.assertNotIn("<changed>", panel)

    def test_identical_ref_skips_compare(self):
        provider, calls = self.provider(head=A)
        result = provider.observe(A)
        self.assertFalse(result["drift"])
        self.assertEqual(result["ancestry"], "identical")
        self.assertEqual(len(calls), 1)

    def test_unknown_ancestry_and_invalid_head_fail_closed(self):
        for comparison in ({"status": "unknown", "files": []},
                           {"status": "ahead"}, []):
            with self.subTest(comparison=comparison):
                provider, _ = self.provider(comparison=comparison)
                with self.assertRaises(ProviderUnavailable):
                    provider.observe(A)
        provider, _ = self.provider(head="not-a-commit")
        with self.assertRaises(ProviderUnavailable):
            provider.observe(A)
        provider, _ = self.provider(head=None)
        with self.assertRaises(ProviderUnavailable):
            provider.observe(A)

    def test_repository_and_ref_bindings_reject_untrusted_targets(self):
        for repository, ref in (("other/repo", "../main"),
                                ("owner/../repo", "main"),
                                (EXPECTED_PROVIDER_REPOSITORY, "main//evil")):
            with self.subTest(repository=repository, ref=ref), self.assertRaises(ValueError):
                GitHubReadOnlyProvider(repository, ref)

    def test_transport_uses_get_and_refuses_redirects(self):
        provider = GitHubReadOnlyProvider(EXPECTED_PROVIDER_REPOSITORY, "test/branch", "test-token")
        requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *unused):
                return False

            def read(self, limit):
                self_limit.append(limit)
                return b'{"commit":{"sha":"' + A.encode() + b'"}}'

        self_limit = []

        class Opener:
            def open(self, request, timeout):
                requests.append((request, timeout))
                return Response()

        provider._opener = Opener()
        observed = provider.observe(A)
        self.assertFalse(observed["drift"])
        request, timeout = requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.full_url,
                         "https://api.github.com/repos/tdoljyj/cross-memory-system/branches/test%2Fbranch")
        self.assertEqual(timeout, 10)
        self.assertEqual(self_limit, [1_048_577])
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")

        class RedirectingOpener:
            def open(self, request, timeout):
                raise HTTPError(request.full_url, 302, "redirect", {}, None)

        provider._opener = RedirectingOpener()
        with self.assertRaises(ProviderUnavailable):
            provider.observe(A)

    def test_gateway_checks_canonical_read_before_provider_and_never_writes(self):
        store = PgMPS02BStore.__new__(PgMPS02BStore)
        provider, calls = self.provider()
        store.github_provider = provider
        read_calls = []

        def read_object(token, oid):
            read_calls.append((token, oid))
            if token != "native-allowed":
                raise ProtocolError("OBJECT_NOT_FOUND", "object not found", 404)
            return {"body": {"repository": EXPECTED_PROVIDER_REPOSITORY,
                             "adopted_exact_commit": A},
                    "revision_id": "rev_a", "adoption_id": "adopt_a"}

        store.read_object = read_object
        with self.assertRaises(ProtocolError):
            store.provider_observation("other-user", OID)
        self.assertEqual(calls, [])
        observed = store.provider_observation("native-allowed", OID)
        self.assertEqual(observed["clued_revision_id"], "rev_a")
        self.assertEqual(observed["clued_adoption_id"], "adopt_a")
        self.assertEqual(read_calls, [("other-user", OID), ("native-allowed", OID),
                                      ("native-allowed", OID)])

    def test_current_change_during_provider_read_rejects_stale_result(self):
        store = PgMPS02BStore.__new__(PgMPS02BStore)
        store.github_provider, _ = self.provider()
        reads = iter((
            {"body": {"repository": EXPECTED_PROVIDER_REPOSITORY,
                      "adopted_exact_commit": A}, "revision_id": "rev_a", "adoption_id": "adopt_a"},
            {"body": {"repository": EXPECTED_PROVIDER_REPOSITORY,
                      "adopted_exact_commit": B}, "revision_id": "rev_b", "adoption_id": "adopt_b"},
        ))
        store.read_object = lambda token, oid: next(reads)
        with self.assertRaises(ProtocolError) as stale:
            store.provider_observation("native-allowed", OID)
        self.assertEqual(stale.exception.code, "STALE_CONTEXT_REQUIRES_REFRESH")

    def test_gateway_route_is_get_only_and_uses_bearer_session(self):
        handler = Handler.__new__(Handler)
        handler.path = f"/v1/objects/{OID}/provider-observation"
        handler.command = "GET"
        handler.headers = {"Authorization": "Bearer native-allowed"}
        calls = []

        def observation(token, oid):
            calls.append((token, oid))
            return {"ok": True}

        handler.store = type("Store", (), {"provider_observation":
                              lambda self, token, oid: observation(token, oid)})()
        self.assertEqual(handler._dispatch(), (200, {"ok": True}))
        self.assertEqual(calls, [("native-allowed", OID)])
        handler.command = "POST"
        with self.assertRaises(ProtocolError):
            handler._dispatch()
        self.assertEqual(len(calls), 1)

    def test_native_fails_closed_on_unavailable_or_stale_observation(self):
        current = {"body": {"repository": EXPECTED_PROVIDER_REPOSITORY,
                            "adopted_exact_commit": A}, "adoption_id": "adopt_a"}
        view = NativeHandler.__new__(NativeHandler)

        def unavailable(self, oid):
            raise ProtocolError("MPS04_PROVIDER_UNAVAILABLE", "unavailable", 503)

        view.client = type("Client", (), {"provider_observation": unavailable})()
        self.assertIn("cannot be verified", view._provider_panel(OID, current))
        provider, _ = self.provider()
        stale = provider.observe(A)
        stale["clued_adoption_id"] = "another_adoption"
        view.client = type("Client", (), {"provider_observation": lambda self, oid: stale})()
        self.assertIn("Reload to compare again", view._provider_panel(OID, current))


if __name__ == "__main__":
    unittest.main()
