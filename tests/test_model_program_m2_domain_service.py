import copy
from datetime import timedelta
import io
from contextlib import redirect_stdout
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/model-program"))
import validate_m2_domain_service as server
from test_model_program_m2_domain_recognition import (
    ControlledClock, NOW, SyntheticCanonicalService, stamp, uid,
)
from validate_m2_dataset_foundation import FoundationError


class SyntheticServerBackend(SyntheticCanonicalService):
    """Synthetic Host authentication, not a real Owner identity or permission."""
    def __init__(self):
        super().__init__()
        contract = server.validate_contract()
        policy = contract["owner_final_recognizer"]
        owner = self.row(50, "decision", "user_explicit", {
            "rationale": "SYNTHETIC SERVER FIXTURE",
            "model_final_recognizer": policy["expected_fields"],
        })
        del self.records[owner["id"]]
        owner.update(**policy["record_ref"], receipt_id=policy["receipt_id"])
        self.policy_id = owner["id"]
        self.records[owner["id"]] = owner
        self.auth = {"status": "AUTHENTICATED", "principal": copy.deepcopy(self.principal),
            "owner_subject_id": self.principal["subject_id"], "canonical_scope": server.domain.SCOPE,
            "action": server.READ_ACTION, "environment": "NON_PRODUCTION", "currentness": "CURRENT",
            "revoked_at": None, "expires_at": stamp(NOW + timedelta(minutes=10)),
            "evaluated_at": stamp(NOW)}
        self.authentication_reads = 0

    def authenticated_context(self):
        self.authentication_reads += 1
        return copy.deepcopy(self.auth)


class DomainServerPreparationTests(unittest.TestCase):
    def setUp(self):
        self.backend = SyntheticServerBackend()
        self.request = copy.deepcopy(self.backend.request)
        self.clock = ControlledClock(NOW)

    def tearDown(self):
        self.assertEqual(self.backend.mutation_calls, 0)

    def reject(self, code=None):
        with self.assertRaises(FoundationError) as caught:
            server.validate_service(self.request, self.backend, clock=self.clock)
        if code:
            self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_" + code)

    def test_authenticated_synthetic_owner_chain_is_read_only_and_not_issued(self):
        result = server.validate_service(self.request, self.backend, clock=self.clock)
        self.assertEqual(result["status"], "PASS_DOMAIN_SERVER_PREPARATION_SYNTHETIC_ONLY")
        self.assertEqual(result["domain_authority_receipt"], "NOT_ISSUED")
        self.assertEqual(result["m2_verdict"], "NOT_ISSUED")
        self.assertFalse(result["route_registered"])
        self.assertFalse(result["permissions_installed"])
        self.assertFalse(result["production_enabled"])
        self.assertGreater(self.backend.authentication_reads, 2)

    def test_absent_and_live_backend_fail_before_authentication(self):
        with self.assertRaises(FoundationError) as caught:
            server.validate_service(self.request)
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_SERVER_BACKEND_NOT_CONFIGURED")
        self.backend.mode = "LIVE"
        self.reject("DOMAIN_SERVER_LIVE_CAPABILITY_NOT_IMPLEMENTED")
        self.assertEqual(self.backend.authentication_reads, 0)

    def test_request_cannot_supply_identity_owner_or_permission(self):
        for key in ("principal", "owner_subject_id", "domain_permission", "authenticated_context"):
            self.request = {**self.backend.request, key: self.backend.auth}
            with self.subTest(key=key):
                self.reject("DOMAIN_REQUEST_SCHEMA")

    def test_unknown_revoked_expired_or_wrong_scope_authentication_is_rejected(self):
        original = copy.deepcopy(self.backend.auth)
        for field, value in (("status", "UNAUTHENTICATED"), ("currentness", "UNKNOWN"),
                ("revoked_at", stamp(NOW)), ("expires_at", stamp(NOW)),
                ("canonical_scope", "global"), ("action", "context:write"),
                ("environment", "PRODUCTION"), ("owner_subject_id", uid(999))):
            self.backend.auth = {**original, field: value}
            with self.subTest(field=field):
                self.reject()

    def test_backend_context_cannot_substitute_another_principal(self):
        self.backend.ctx["principal"] = {"subject_id": uid(999), "binding_id": uid(2)}
        self.reject("DOMAIN_SERVER_CONTEXT_PRINCIPAL_BINDING")

    def test_binding_change_during_reads_is_rejected(self):
        original = self.backend.authenticated_context
        def auth():
            result = original()
            if self.backend.authentication_reads > 3:
                result["principal"]["binding_id"] = uid(999)
            return result
        self.backend.authenticated_context = auth
        self.reject("DOMAIN_SERVER_PRINCIPAL_CHANGED")

    def test_valid_authentication_followed_by_none_or_malformed_return_is_rejected_immediately(self):
        for invalid in (None, {}, [], False, "AUTHENTICATED"):
            self.backend = SyntheticServerBackend()
            self.request = copy.deepcopy(self.backend.request)
            def auth():
                self.backend.authentication_reads += 1
                return copy.deepcopy(self.backend.auth if self.backend.authentication_reads == 1 else invalid)
            self.backend.authenticated_context = auth
            with self.subTest(invalid=invalid), patch.object(
                    self.backend, "read_record", wraps=self.backend.read_record) as read:
                self.reject("DOMAIN_SERVER_AUTH_SHAPE")
                self.assertEqual(self.backend.authentication_reads, 2)
                read.assert_not_called()
                self.assertEqual(self.backend.mutation_calls, 0)

    def test_initial_missing_authentication_is_rejected(self):
        self.backend.authenticated_context = lambda: None
        self.reject("DOMAIN_SERVER_AUTH_SHAPE")

    def test_authentication_exception_after_success_cannot_reuse_old_identity(self):
        with patch.object(self.backend, "authenticated_context", side_effect=[
                copy.deepcopy(self.backend.auth), RuntimeError("INTERNAL DETAIL")]), patch.object(
                self.backend, "read_record") as read:
            self.reject("DOMAIN_SERVICE_UNAVAILABLE_OR_INVALID")
            read.assert_not_called()

    def test_owner_designation_is_exact_current_decision_not_a_domain_grant(self):
        self.backend.records[self.backend.policy_id]["version"] += 1
        self.reject()
        self.backend = SyntheticServerBackend()
        self.backend.records[self.backend.grant_id]["type_fields"] = {"rationale": "Only Owner designation"}
        self.reject("DOMAIN_PERMISSION_REQUIRED")

    def test_owner_decision_revocation_during_reads_is_rejected(self):
        original = self.backend.authorization_context
        def auth():
            result = original()
            if self.backend.auth_reads == 1:
                self.backend.records[self.backend.policy_id]["lifecycle_status"] = "revoked"
            return result
        self.backend.authorization_context = auth
        self.reject()

    def test_domain_permission_revocation_and_producer_version_are_rejected(self):
        self.backend.records[self.backend.grant_id]["type_fields"]["domain_permission"]["revoked_at"] = stamp(NOW)
        self.reject("DOMAIN_PERMISSION_REVOKED")
        self.backend = SyntheticServerBackend()
        self.backend.records[self.backend.producer_id]["version"] += 1
        self.reject()

    def test_domain_permission_expiring_during_reads_is_rejected(self):
        self.backend.records[self.backend.grant_id]["type_fields"]["domain_permission"]["expires_at"] = stamp(NOW + timedelta(seconds=1))
        original = self.backend.read_receipt
        def read(receipt_id):
            result = original(receipt_id)
            self.clock.value = NOW + timedelta(seconds=1)
            return result
        self.backend.read_receipt = read
        self.reject("DOMAIN_PERMISSION_EXPIRED_OR_NOT_YET_VALID")

    def test_session_expiring_after_a_read_is_rejected_by_acceptance_clock(self):
        self.backend.auth["expires_at"] = stamp(NOW + timedelta(seconds=1))
        original = self.backend.read_receipt
        def read(receipt_id):
            result = original(receipt_id)
            self.clock.value = NOW + timedelta(seconds=1)
            return result
        self.backend.read_receipt = read
        self.reject("DOMAIN_SERVER_SESSION_EXPIRED")

    def test_receipt_actor_and_event_version_remain_bound_to_existing_core(self):
        receipt = self.backend.receipts[self.request["recognition_receipt_id"]]
        receipt["binding_id"] = uid(999)
        self.reject()
        self.backend = SyntheticServerBackend()
        self.backend.events["101"]["committed_canonical_version"] += 1
        self.reject("DOMAIN_EVENT_BINDING")

    def test_backend_failures_are_sanitized(self):
        with patch.object(self.backend, "authenticated_context", side_effect=RuntimeError("INTERNAL DETAIL")):
            with self.assertRaises(FoundationError) as caught:
                server.validate_service(self.request, self.backend, clock=self.clock)
        self.assertNotIn("INTERNAL", str(caught.exception))
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_SERVICE_UNAVAILABLE_OR_INVALID")

    def test_contract_cli_retains_unknown_identity_and_no_issuance(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(server.main(), 0)
        self.assertIn('"authenticated_owner_identity": "UNKNOWN"', output.getvalue())
        self.assertIn("NOT_ISSUED", output.getvalue())


if __name__ == "__main__":
    unittest.main()
