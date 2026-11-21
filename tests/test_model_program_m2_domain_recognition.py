import copy
from datetime import datetime, timedelta, timezone
import io
from pathlib import Path
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts/model-program"))
import validate_m2_domain_recognition as domain
from validate_m2_dataset_foundation import FoundationError, digest

NOW = datetime(2026, 10, 1, 9, 24, tzinfo=timezone.utc)


def uid(number):
    return "00000000-0000-0000-0000-" + str(number).zfill(12)


def stamp(value):
    return value.isoformat().replace("+00:00", "Z")


def reference(row):
    return {key: row[key] for key in ("id", "version", "content_hash")}


class ControlledClock:
    def __init__(self, value):
        self.value = value

    def __call__(self):
        return self.value


class SyntheticCanonicalService:
    """In-memory TEST DOUBLE, never a live authority or credential store.

    Fixture hashes stand in for server hashes; no fixture becomes a service proof.
    The interface matches normalized existing M1 record/event/receipt read fields.
    """
    mode = domain.MODE

    def __init__(self):
        self.contract, _schema = domain.validate_contract()
        self.principal = {"subject_id": uid(1), "binding_id": uid(2)}
        self.records, self.receipts, self.events = {}, {}, {}
        self.mutation_calls = 0
        self.auth_reads = 0
        self.deny_after_first_read = False
        c = self.contract
        producer = self.row(10, "state", "user_explicit", {"domain_producer": {
            "service": domain.SERVICE, "role": domain.ROLE, "domain_owner": "MODEL PROGRAM",
            "environment": "NON_PRODUCTION", "principal": self.principal,
            "authority_registry_sha256": c["authority_registry_sha256"]}})
        self.producer_id = producer["id"]
        grant = self.row(20, "decision", "user_explicit", {"rationale": "SYNTHETIC GRANT ONLY",
            "domain_permission": {"status": "active", "revoked_at": None,
                "not_before": "2026-10-01T09:00:00Z", "expires_at": "2026-10-01T10:00:00Z",
                "action": domain.ACTION, "effect": domain.EFFECT, "environment": "NON_PRODUCTION",
                "canonical_scope": domain.SCOPE, "subject": c["subject"],
                "principal": self.principal, "producer_registration_ref": reference(producer)}})
        self.grant_id = grant["id"]
        self.ctx = {"service": domain.SERVICE, "domain_admission": "AUTHORIZED",
            "environment": "NON_PRODUCTION", "action": domain.ACTION, "subject": c["subject"],
            "principal": self.principal, "permission_record_ref": reference(grant),
            "evaluated_at": stamp(NOW)}
        adoption = c["owner_adoption"]
        owner = self.row(25, "decision", "user_explicit", {})
        del self.records[owner["id"]]
        owner.update(id=adoption["canonical_record_id"], version=adoption["record_version"],
            content_hash=adoption["record_content_sha256"], receipt_id=adoption["canonical_receipt_id"])
        self.records[owner["id"]] = owner
        self.owner_id = owner["id"]
        payload = {"contract_id": c["contract_id"], "contract_version": c["version"],
            "contract_sha256": domain.CONTRACT_SHA256, "subject": c["subject"],
            "owner_adoption": adoption, "permission_record_ref": reference(grant),
            "producer_registration_ref": reference(producer),
            "producer": {"service": domain.SERVICE, **self.principal}, "effect": domain.EFFECT}
        record = self.row(30, "state", "observed", {
            "state_kind": "model_dataset_split_domain_recognition", "domain_recognition": payload})
        self.record_id = record["id"]
        receipt = {"id": record["receipt_id"], "status": "committed", "operation_family": "record_mutation",
            "user_id": self.principal["subject_id"], "binding_id": self.principal["binding_id"],
            "target_refs": [{"id": record["id"], "kind": "record", "role": "primary"}],
            "committed_versions": {record["id"]: record["version"]}, "canonical_version": 100,
            "event_ids": ["101"], "evaluated_at": stamp(NOW)}
        self.receipts[receipt["id"]] = receipt
        self.events["101"] = {"id": "101", "canonical_event_type": "record_created", "result": "success",
            "receipt_id": receipt["id"], "event_scope": domain.SCOPE,
            "target_refs": receipt["target_refs"], "committed_canonical_version": 100,
            "actor_user_id": self.principal["subject_id"], "actor_binding_id": self.principal["binding_id"],
            "evaluated_at": stamp(NOW)}
        self.request = {"schema_version": "clued.model-dataset-split-domain-recognition-request-candidate/1",
            "contract_sha256": domain.CONTRACT_SHA256, "subject": copy.deepcopy(c["subject"]),
            "recognition_record_ref": reference(record), "recognition_receipt_id": receipt["id"]}

    def row(self, number, record_type, authority, fields):
        row = {"id": uid(number), "version": 1, "record_type": record_type,
            "canonical_scope": domain.SCOPE, "authority": authority, "lifecycle_status": "active",
            "record_currentness": "CURRENT", "type_fields": copy.deepcopy(fields),
            "receipt_id": uid(number + 1), "evaluated_at": stamp(NOW)}
        row["content_hash"] = digest(row)  # Test stand-in, not M1's hash algorithm.
        self.records[row["id"]] = row
        return row

    def authorization_context(self):
        self.auth_reads += 1
        result = copy.deepcopy(self.ctx)
        if self.deny_after_first_read and self.auth_reads > 1:
            result["domain_admission"] = "DENIED"
        return result

    def read_record(self, record_id):
        return copy.deepcopy(self.records[record_id])

    def read_receipt(self, receipt_id):
        return copy.deepcopy(self.receipts[receipt_id])

    def read_event(self, event_id):
        return copy.deepcopy(self.events[event_id])

    def mutate(self, _request):
        self.mutation_calls += 1
        raise AssertionError("A candidate validator must never write Canonical data")


class DomainRecognitionTests(unittest.TestCase):
    def setUp(self):
        self.service = SyntheticCanonicalService()
        self.request = copy.deepcopy(self.service.request)

    def tearDown(self):
        self.assertEqual(self.service.mutation_calls, 0)

    def reject(self, code=None):
        with self.assertRaises(FoundationError) as caught:
            domain.validate_recognition(self.request, self.service, clock=lambda: NOW)
        if code:
            self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_" + code)
        return caught.exception

    def test_valid_chain_uses_existing_receipt_core_but_is_synthetic_and_read_only(self):
        before = copy.deepcopy(self.request)
        result = domain.validate_recognition(self.request, self.service, clock=lambda: NOW)
        self.assertEqual(result["status"], "PASS_DOMAIN_RECOGNITION_ADAPTER_SYNTHETIC_ONLY")
        self.assertEqual(result["receipt_operation_family"], "record_mutation")
        self.assertEqual(result["trust_boundary"], "SYNTHETIC_TEST_DOUBLE")
        self.assertEqual(result["domain_authority_receipt"], "NOT_ISSUED")
        self.assertEqual(result["m2_verdict"], "NOT_ISSUED")
        self.assertFalse(result["training_or_data_use_authorized"])
        self.assertFalse(result["production_enabled"])
        self.assertEqual(self.request, before)
        self.assertEqual(self.service.auth_reads, 2)

    def test_no_backend_and_live_backend_are_rejected(self):
        with self.assertRaises(FoundationError) as caught:
            domain.validate_recognition(self.request, clock=lambda: NOW)
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_AUTHORITY_NOT_CONFIGURED")
        self.service.mode = "AUTHENTICATED_LIVE_SERVICE"
        self.reject("DOMAIN_LIVE_CAPABILITY_NOT_IMPLEMENTED")

    def test_caller_cannot_supply_principal_permission_or_currentness(self):
        for field in ("principal", "permission_record_ref", "domain_admission", "record_currentness", "mode", "clock"):
            self.request = copy.deepcopy(self.service.request)
            self.request[field] = "AUTHORIZED"
            with self.subTest(field=field):
                self.reject("DOMAIN_REQUEST_SCHEMA")

    def test_wrong_contract_definition_schema_or_version_is_rejected(self):
        cases = [("contract_sha256", "0" * 64), ("definition_sha256", "0" * 64),
                 ("instance_schema_sha256", "0" * 64), ("version", "v0.2")]
        for field, value in cases:
            self.request = copy.deepcopy(self.service.request)
            target = self.request if field == "contract_sha256" else self.request["subject"]
            target[field] = value
            with self.subTest(field=field):
                self.reject()

    def test_generic_context_write_and_absent_domain_admission_are_insufficient(self):
        self.service.ctx["domain_admission"] = "CONTEXT_WRITE_ONLY"
        self.reject("DOMAIN_ACTION_NOT_AUTHORIZED")

    def test_adoption_and_engineering_approval_cannot_replace_a_permission(self):
        self.service.ctx["permission_record_ref"] = reference(self.service.records[self.service.owner_id])
        self.reject("DOMAIN_PERMISSION_REQUIRED")

    def test_revoked_expired_future_and_unbounded_permissions_are_rejected(self):
        cases = [("revoked_at", stamp(NOW)), ("status", "revoked"),
                 ("expires_at", stamp(NOW)), ("not_before", stamp(NOW + timedelta(seconds=1))),
                 ("expires_at", "2027-10-01T09:24:00Z")]
        initial = copy.deepcopy(self.service.records[self.service.grant_id])
        for field, value in cases:
            self.service.records[self.service.grant_id] = copy.deepcopy(initial)
            self.service.records[self.service.grant_id]["type_fields"]["domain_permission"][field] = value
            with self.subTest(field=field):
                self.reject()

    def test_permission_is_scoped_to_identity_action_environment_effect_and_object(self):
        grant = self.service.records[self.service.grant_id]["type_fields"]["domain_permission"]
        initial = copy.deepcopy(grant)
        for field, value in (("action", "context:write"), ("canonical_scope", "global"),
                             ("environment", "PRODUCTION"), ("effect", "DATA_USE_AUTHORIZED"),
                             ("subject", {**grant["subject"], "version": "v0.2"}),
                             ("principal", {**grant["principal"], "binding_id": uid(999)})):
            self.service.records[self.service.grant_id]["type_fields"]["domain_permission"] = {**initial, field:value}
            with self.subTest(field=field):
                self.reject("DOMAIN_PERMISSION_SCOPE")

    def test_missing_revocation_information_is_not_permission(self):
        del self.service.records[self.service.grant_id]["type_fields"]["domain_permission"]["revoked_at"]
        self.reject("DOMAIN_PERMISSION_REQUIRED")

    def test_unregistered_or_wrong_producer_role_is_rejected(self):
        self.service.records[self.service.producer_id]["type_fields"]["domain_producer"]["role"] = "AGENT"
        self.reject("DOMAIN_PRODUCER_REGISTRATION")

    def test_any_source_record_unknown_revoked_or_wrong_scope_is_rejected(self):
        for record_id in (self.service.owner_id, self.service.producer_id, self.service.grant_id, self.service.record_id):
            original = copy.deepcopy(self.service.records[record_id])
            for field, value in (("record_currentness", "UNKNOWN"), ("lifecycle_status", "revoked"),
                                 ("canonical_scope", "global"), ("version", 2), ("content_hash", "0" * 64)):
                self.service.records[record_id] = {**original, field:value}
                with self.subTest(record_id=record_id, field=field):
                    self.reject()
            self.service.records[record_id] = original

    def test_stale_future_and_invalid_service_observations_are_rejected(self):
        for value in (stamp(NOW - timedelta(seconds=301)), stamp(NOW + timedelta(seconds=1)), "INVALID"):
            self.service.ctx["evaluated_at"] = value
            with self.subTest(value=value):
                self.reject()

    def test_wrong_owner_adoption_receipt_is_rejected(self):
        self.service.records[self.service.owner_id]["receipt_id"] = uid(999)
        self.reject("DOMAIN_OWNER_RECEIPT_BINDING")

    def test_ordinary_record_receipt_is_not_domain_recognition(self):
        self.service.records[self.service.record_id]["type_fields"] = {"state_kind": "manual"}
        self.reject("DOMAIN_RECOGNITION_BINDING")

    def test_recognition_cannot_widen_or_change_its_exact_bindings(self):
        row = self.service.records[self.service.record_id]
        initial = copy.deepcopy(row["type_fields"]["domain_recognition"])
        for field, value in (("effect", "M2_PASS"), ("contract_version", "v0.2"),
                             ("producer", {"service": "local"}), ("owner_adoption", {}),
                             ("permission_record_ref", {}), ("producer_registration_ref", {})):
            row["type_fields"]["domain_recognition"] = {**initial, field:value}
            with self.subTest(field=field):
                self.reject("DOMAIN_RECOGNITION_BINDING")

    def test_uncommitted_or_wrong_operation_actor_target_and_version_receipt_is_rejected(self):
        rid = self.request["recognition_receipt_id"]
        original = copy.deepcopy(self.service.receipts[rid])
        for field, value in (("status", "rejected"), ("operation_family", "checkpoint"),
                             ("binding_id", uid(999)), ("user_id", uid(999)),
                             ("target_refs", []), ("committed_versions", {self.service.record_id: 2}),
                             ("committed_versions", {self.service.record_id: True}), ("event_ids", [])):
            self.service.receipts[rid] = {**original, field:value}
            with self.subTest(field=field, value=value):
                self.reject()

    def test_wrong_receipt_reference_and_event_binding_are_rejected(self):
        self.request["recognition_receipt_id"] = uid(999)
        self.reject("DOMAIN_RECOGNITION_RECEIPT_BINDING")
        self.request = copy.deepcopy(self.service.request)
        original = copy.deepcopy(self.service.events["101"])
        for field, value in (("receipt_id", uid(999)), ("actor_binding_id", uid(999)),
                             ("actor_user_id", uid(999)), ("target_refs", []), ("result", "failure"),
                             ("event_scope", "global"), ("committed_canonical_version", 101)):
            self.service.events["101"] = {**original, field:value}
            with self.subTest(field=field):
                self.reject("DOMAIN_EVENT_BINDING")

    def test_revocation_during_reads_is_rejected(self):
        self.service.deny_after_first_read = True
        self.reject("DOMAIN_PERMISSION_CHANGED")

    def advancing_clock(self, start, end, *, refresh_final):
        clock = ControlledClock(start)
        for view in (self.service.ctx, *self.service.records.values(),
                     *self.service.receipts.values(), *self.service.events.values()):
            view["evaluated_at"] = stamp(start)
        original_auth = self.service.authorization_context
        def auth():
            if self.service.auth_reads == 1:
                clock.value = end
            value = original_auth()
            if refresh_final and self.service.auth_reads == 2:
                value["evaluated_at"] = stamp(end)
            return value
        self.service.authorization_context = auth
        return clock

    def test_permission_expiring_during_reads_is_rejected_with_stale_or_refreshed_final_observation(self):
        start = datetime(2026, 10, 1, 9, 59, 59, tzinfo=timezone.utc)
        for refresh in (False, True):
            self.service = SyntheticCanonicalService()
            self.request = copy.deepcopy(self.service.request)
            clock = self.advancing_clock(start, start + timedelta(seconds=2), refresh_final=refresh)
            with self.subTest(refresh=refresh), self.assertRaises(FoundationError) as caught:
                domain.validate_recognition(self.request, self.service, clock=clock)
            self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_PERMISSION_EXPIRED_OR_NOT_YET_VALID")
            self.assertEqual(self.service.mutation_calls, 0)

    def test_unexpired_permission_with_refreshed_final_observation_passes(self):
        start = datetime(2026, 10, 1, 9, 59, 50, tzinfo=timezone.utc)
        clock = self.advancing_clock(start, start + timedelta(seconds=2), refresh_final=True)
        result = domain.validate_recognition(self.request, self.service, clock=clock)
        self.assertEqual(result["status"], "PASS_DOMAIN_RECOGNITION_ADAPTER_SYNTHETIC_ONLY")
        self.assertEqual(result["domain_authority_receipt"], "NOT_ISSUED")

    def test_default_host_clock_is_resampled_at_final_acceptance(self):
        start = datetime(2026, 10, 1, 9, 59, 59, tzinfo=timezone.utc)
        clock = self.advancing_clock(start, start + timedelta(seconds=2), refresh_final=False)
        with patch.object(domain, "utc_now", clock), self.assertRaises(FoundationError) as caught:
            domain.validate_recognition(self.request, self.service)
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_PERMISSION_EXPIRED_OR_NOT_YET_VALID")

    def test_observations_that_age_out_during_reads_are_rejected(self):
        clock = self.advancing_clock(NOW, NOW + timedelta(seconds=301), refresh_final=True)
        with self.assertRaises(FoundationError) as caught:
            domain.validate_recognition(self.request, self.service, clock=clock)
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_STALE_SERVICE_VIEW")

    def test_clock_regression_at_final_acceptance_is_rejected(self):
        clock = self.advancing_clock(NOW, NOW - timedelta(seconds=1), refresh_final=True)
        with self.assertRaises(FoundationError) as caught:
            domain.validate_recognition(self.request, self.service, clock=clock)
        self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_CLOCK_REGRESSED")

    def test_clock_advance_then_rollback_after_entry_is_rejected_immediately(self):
        start = datetime(2026, 10, 1, 9, 59, 50, tzinfo=timezone.utc)
        expired = start + timedelta(seconds=11)
        rollback = start + timedelta(seconds=5)
        for rollback_sample in (9, 10):
            self.service = SyntheticCanonicalService()
            self.request = copy.deepcopy(self.service.request)
            for view in (self.service.ctx, *self.service.records.values(),
                         *self.service.receipts.values(), *self.service.events.values()):
                view["evaluated_at"] = stamp(start)
            samples = ([start] * 7 + [expired] * (rollback_sample - 8)
                       + [rollback] * (11 - rollback_sample))
            with self.subTest(rollback_sample=rollback_sample), patch.object(
                    domain, "utc_now", side_effect=samples) as clock:
                with self.assertRaises(FoundationError) as caught:
                    domain.validate_recognition(self.request, self.service)
                self.assertEqual(caught.exception.code, "CLUED_MODEL_M2_DOMAIN_CLOCK_REGRESSED")
                self.assertEqual(clock.call_count, rollback_sample)
                self.assertEqual(self.service.mutation_calls, 0)

    def test_clock_monotonicity_state_is_local_to_each_request(self):
        for value in (NOW + timedelta(seconds=1), NOW):
            result = domain.validate_recognition(self.request, self.service, clock=lambda: value)
            self.assertEqual(result["status"], "PASS_DOMAIN_RECOGNITION_ADAPTER_SYNTHETIC_ONLY")

    def test_updated_observation_during_a_record_read_is_not_future(self):
        clock = ControlledClock(NOW)
        original_read = self.service.read_record
        def read(record_id):
            value = original_read(record_id)
            if record_id == self.service.record_id:
                clock.value = NOW + timedelta(seconds=2)
                value["evaluated_at"] = stamp(clock.value)
            return value
        self.service.read_record = read
        result = domain.validate_recognition(self.request, self.service, clock=clock)
        self.assertEqual(result["status"], "PASS_DOMAIN_RECOGNITION_ADAPTER_SYNTHETIC_ONLY")

    def test_service_failure_is_sanitized_and_never_writes(self):
        with patch.object(self.service, "read_receipt", side_effect=RuntimeError("SECRET INTERNAL DETAIL")):
            error = self.reject("DOMAIN_SERVICE_UNAVAILABLE_OR_INVALID")
        self.assertNotIn("SECRET", str(error))

    def test_changed_contract_or_existing_core_source_is_rejected(self):
        original_read = Path.read_bytes
        for name in (domain.CONTRACT.name, "records.ts"):
            def changed(path):
                raw = original_read(path)
                return raw + b" " if path.name == name else raw
            with self.subTest(name=name), patch.object(Path, "read_bytes", changed):
                self.reject()

    def test_cli_never_claims_actual_domain_authority(self):
        stream = io.StringIO()
        with redirect_stdout(stream):
            self.assertEqual(domain.main([]), 0)
            self.assertEqual(domain.main(["--require-domain-authority"]), 1)
        self.assertIn("NOT_ISSUED", stream.getvalue())
        self.assertIn("DOMAIN_AUTHORITY_NOT_CONFIGURED", stream.getvalue())


if __name__ == "__main__":
    unittest.main()
