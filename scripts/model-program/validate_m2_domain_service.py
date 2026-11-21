#!/usr/bin/env python3
"""Unregistered, read-only server facade candidate; synthetic backend only."""
from __future__ import annotations

import copy
import hashlib
import json
import re

import validate_m2_domain_recognition as domain
from validate_m2_dataset_foundation import BASE, FoundationError, load, require

CONTRACT = BASE / "DatasetSplitDomainServerPreparation.candidate.json"
CONTRACT_SHA256 = "dbdc230a9926a69175f02c535f38757f446cebcda11dec4f293f55a2c3cefd6f"
READ_ACTION = "DatasetSplit.definition.verify"
AUTH_KEYS = {"status", "principal", "owner_subject_id", "canonical_scope", "action",
             "environment", "currentness", "revoked_at", "expires_at", "evaluated_at"}


def validate_contract():
    require(hashlib.sha256(CONTRACT.read_bytes()).hexdigest() == CONTRACT_SHA256,
            "DOMAIN_SERVER_CONTRACT_IDENTITY")
    contract = load(CONTRACT)
    original, _schema = domain.validate_contract()
    require(contract["subject"] == original["subject"], "DOMAIN_SERVER_SUBJECT_BINDING")
    require(contract["authenticated_owner_subject_id"] is None
            and contract["authenticated_binding_id"] is None
            and contract["route_registered"] is False
            and contract["permissions_installed"] is False
            and contract["production_enabled"] is False,
            "DOMAIN_SERVER_CANDIDATE_BOUNDARY")
    return contract


class ServerCanonicalReader:
    """Host backend must authenticate independently of the JSON request.

    This facade introduces no HTTP route, token parsing, RPC registration,
    mutation, issuer or credential store. A live backend is rejected before
    authentication or any read. Normalized M1 reads remain the only data source.
    """
    mode = domain.MODE

    def __init__(self, backend, contract, source_clock):
        require(backend is not None, "DOMAIN_SERVER_BACKEND_NOT_CONFIGURED")
        require(getattr(backend, "mode", None) == domain.MODE,
                "DOMAIN_SERVER_LIVE_CAPABILITY_NOT_IMPLEMENTED")
        self.backend, self.contract = backend, contract
        self.principal, self.latest_auth, self.latest_sample = None, None, None
        self.authentication_started = False
        self.source_clock = source_clock

    def check_auth(self, view, now):
        require(isinstance(view, dict) and set(view) == AUTH_KEYS, "DOMAIN_SERVER_AUTH_SHAPE")
        domain.fresh(view, now)
        require(view["status"] == "AUTHENTICATED" and view["currentness"] == "CURRENT"
                and view["revoked_at"] is None, "DOMAIN_SERVER_AUTH_REVOKED_OR_UNKNOWN")
        require(now < domain.timestamp(view["expires_at"]), "DOMAIN_SERVER_SESSION_EXPIRED")
        principal = view["principal"]
        require(isinstance(principal, dict) and set(principal) == {"subject_id", "binding_id"}
                and all(isinstance(v, str) and re.fullmatch(domain.UUID, v)
                        for v in principal.values()), "DOMAIN_SERVER_PRINCIPAL_SHAPE")
        require(view["owner_subject_id"] == principal["subject_id"],
                "DOMAIN_SERVER_OWNER_IDENTITY_REQUIRED")
        require(view["canonical_scope"] == domain.SCOPE and view["action"] == READ_ACTION
                and view["environment"] == "NON_PRODUCTION", "DOMAIN_SERVER_READ_ADMISSION")
        require(self.principal is None or self.principal == principal, "DOMAIN_SERVER_PRINCIPAL_CHANGED")
        self.principal = copy.deepcopy(principal)

    def clock(self):
        value = domain.clock_time(self.source_clock)
        require(self.latest_sample is None or value >= self.latest_sample, "DOMAIN_CLOCK_REGRESSED")
        self.latest_sample = value
        if self.authentication_started:
            self.check_auth(self.latest_auth, value)
        return value

    def authenticate(self):
        # Current server authentication is never constructed from request JSON.
        self.authentication_started = True
        self.latest_auth = None  # Never retain an old authentication on failure.
        self.latest_auth = copy.deepcopy(self.backend.authenticated_context())
        self.clock()  # Also checks expiry/revocation at every later clock sample.

    def authorization_context(self):
        self.authenticate()
        policy = self.contract["owner_final_recognizer"]
        owner = domain.current_record(self, policy["record_ref"], self.clock, "decision", "user_explicit")
        require(owner.get("receipt_id") == policy["receipt_id"]
                and owner["type_fields"].get("model_final_recognizer") == policy["expected_fields"],
                "DOMAIN_SERVER_OWNER_DECISION_BINDING")
        ctx = copy.deepcopy(self.backend.authorization_context())
        self.authenticate()
        require(ctx.get("principal") == self.principal, "DOMAIN_SERVER_CONTEXT_PRINCIPAL_BINDING")
        return ctx

    def read_record(self, record_id):
        self.authenticate()
        return copy.deepcopy(self.backend.read_record(record_id))

    def read_receipt(self, receipt_id):
        self.authenticate()
        return copy.deepcopy(self.backend.read_receipt(receipt_id))

    def read_event(self, event_id):
        self.authenticate()
        return copy.deepcopy(self.backend.read_event(event_id))


def validate_service(request, backend=None, *, clock=None):
    """Read-only local invocation; no installed server endpoint or live grant."""
    try:
        contract = validate_contract()
        reader = ServerCanonicalReader(backend, contract, clock or domain.utc_now)
        result = domain.validate_recognition(request, reader, clock=reader.clock)
        return {**result, "status": "PASS_DOMAIN_SERVER_PREPARATION_SYNTHETIC_ONLY",
                "server_contract_sha256": CONTRACT_SHA256, "route_registered": False,
                "permissions_installed": False}
    except FoundationError:
        raise
    except Exception:
        raise FoundationError("DOMAIN_SERVER_SERVICE_UNAVAILABLE_OR_INVALID") from None


def main():
    try:
        validate_contract()
    except (FoundationError, OSError, ValueError):
        print(json.dumps({"status": "FAIL_DOMAIN_SERVER_CONTRACT"}))
        return 1
    print(json.dumps({"status": "PASS_DOMAIN_SERVER_CONTRACT_ONLY", "live_backend": "NOT_CONFIGURED",
                      "authenticated_owner_identity": "UNKNOWN", "domain_authority_receipt": "NOT_ISSUED",
                      "m2_verdict": "NOT_ISSUED", "production_enabled": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
