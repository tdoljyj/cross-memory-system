#!/usr/bin/env python3
"""Non-production, read-only DatasetSplit domain-recognition adapter candidate.

Only a Host-injected synthetic service double is supported. There is no live
transport, permission issuer, mutation, persistence or DomainAuthorityReceipt.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Protocol

from jsonschema import Draft202012Validator

from validate_m2_adopted_definition import validate_baseline
from validate_m2_dataset_foundation import BASE, FoundationError, digest, load, require
from validate_m2_dataset_split import verify_artifact

CONTRACT = BASE / "DatasetSplitDomainRecognition.candidate.json"
CONTRACT_SHA256 = "d8599ca8148f63a7893133ad3b13426edab25f3f48bc5291b1fb7c038a04754f"
SCHEMA_PATH = "development/contracts/model-program/m2/schemas/DatasetSplitDomainRecognitionRequest.schema.json"
SCOPE = "project:0597aa60-9b98-4da6-a4ab-63d7705b632f"
SERVICE = "clued-cloud/supabase"
EFFECT = "NON_PRODUCTION_DEFINITION_RECOGNITION_ONLY"
ACTION = "DatasetSplit.definition.recognize"
ROLE = "EXISTING_MODEL_DOMAIN_AUTHORITY_DELEGATE"
MODE = "SYNTHETIC_TEST_DOUBLE"
MAX_READ_AGE_SECONDS = 300
MAX_PERMISSION_WINDOW_SECONDS = 3600
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def utc_now():
    return datetime.now(timezone.utc)


def clock_time(clock):
    value = clock()
    require(isinstance(value, datetime) and value.tzinfo == timezone.utc, "DOMAIN_CLOCK")
    return value


class CanonicalReader(Protocol):
    """Host-owned boundary; never constructed from a request or fixture JSON.

    Currentness, principal, domain admission, revocation and server content hashes
    must come from the authenticated existing service, not a caller assertion.
    This candidate implements the synthetic boundary only. Live installation
    requires separately authorized producer registration and server admission.
    """
    mode: str

    def authorization_context(self) -> dict: ...
    def read_record(self, record_id: str) -> dict: ...
    def read_receipt(self, receipt_id: str) -> dict: ...
    def read_event(self, event_id: str) -> dict: ...


def validate_contract():
    require(hashlib.sha256(CONTRACT.read_bytes()).hexdigest() == CONTRACT_SHA256,
            "DOMAIN_CONTRACT_IDENTITY")
    contract = load(CONTRACT)
    ref, definition, _schema, _manifest = validate_baseline()
    schema_path = verify_artifact(contract["request_schema"], SCHEMA_PATH)
    schema = load(schema_path)
    Draft202012Validator.check_schema(schema)
    require(contract["subject"] == {
        "definition_id": definition["definition_id"], "version": "v0.1",
        "definition_sha256": ref["definition"]["sha256"],
        "instance_schema_sha256": ref["instance_schema"]["sha256"]}, "DOMAIN_SUBJECT_BINDING")
    require(contract["owner_adoption"] == ref["owner_adoption"], "DOMAIN_OWNER_BINDING")
    for artifact in contract["existing_core_sources"]:
        verify_artifact(artifact, artifact["path"])
    return contract, schema


def timestamp(value):
    require(isinstance(value, str) and value.endswith("Z"), "DOMAIN_TIME")
    try:
        result = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        require(False, "DOMAIN_TIME")
    return result


def fresh(view, now):
    require(isinstance(view, dict), "DOMAIN_SERVICE_VIEW")
    age = (now - timestamp(view.get("evaluated_at"))).total_seconds()
    require(0 <= age <= MAX_READ_AGE_SECONDS, "DOMAIN_STALE_SERVICE_VIEW")


def current_record(reader, ref, clock, record_type, authority=None):
    require(isinstance(ref, dict) and set(ref) == {"id", "version", "content_hash"}
            and isinstance(ref["id"], str) and re.fullmatch(UUID, ref["id"])
            and type(ref["version"]) is int and ref["version"] > 0
            and isinstance(ref["content_hash"], str)
            and re.fullmatch(r"[0-9a-f]{64}", ref["content_hash"]), "DOMAIN_RECORD_REFERENCE")
    row = reader.read_record(ref["id"])
    fresh(row, clock_time(clock))
    require(row.get("id") == ref["id"] and type(row.get("version")) is int
            and row["version"] == ref["version"]
            and row.get("content_hash") == ref["content_hash"], "DOMAIN_RECORD_BINDING")
    require(row.get("record_currentness") == "CURRENT"
            and row.get("lifecycle_status") == "active", "DOMAIN_RECORD_NOT_CURRENT")
    require(row.get("canonical_scope") == SCOPE and row.get("record_type") == record_type,
            "DOMAIN_RECORD_SCOPE_OR_TYPE")
    if authority is not None:
        require(row.get("authority") == authority, "DOMAIN_RECORD_AUTHORITY")
    return row


def committed_receipt(reader, row, principal, clock):
    receipt = reader.read_receipt(row["receipt_id"])
    fresh(receipt, clock_time(clock))
    require(receipt.get("id") == row["receipt_id"]
            and receipt.get("status") == "committed"
            and receipt.get("operation_family") == "record_mutation", "DOMAIN_RECEIPT_STATUS_OR_OPERATION")
    require(receipt.get("user_id") == principal["subject_id"]
            and receipt.get("binding_id") == principal["binding_id"], "DOMAIN_RECEIPT_PRODUCER")
    require(receipt.get("target_refs") == [{"id": row["id"], "kind": "record", "role": "primary"}]
            and receipt.get("committed_versions") == {row["id"]: row["version"]}
            and type(receipt["committed_versions"].get(row["id"])) is int, "DOMAIN_RECEIPT_TARGET")
    event_ids = receipt.get("event_ids")
    require(isinstance(event_ids, list) and len(event_ids) == 1, "DOMAIN_RECEIPT_EVENT")
    event = reader.read_event(event_ids[0])
    fresh(event, clock_time(clock))
    require(event.get("id") == event_ids[0]
            and event.get("canonical_event_type") in ("record_created", "record_updated")
            and event.get("result") == "success"
            and event.get("receipt_id") == receipt["id"]
            and event.get("event_scope") == SCOPE
            and event.get("target_refs") == receipt["target_refs"]
            and type(receipt.get("canonical_version")) is int and receipt["canonical_version"] > 0
            and type(event.get("committed_canonical_version")) is int
            and event["committed_canonical_version"] == receipt.get("canonical_version")
            and event.get("actor_user_id") == principal["subject_id"]
            and event.get("actor_binding_id") == principal["binding_id"], "DOMAIN_EVENT_BINDING")
    return receipt, event


def _validate_recognition(request, reader, clock):
    contract, schema = validate_contract()
    require(not list(Draft202012Validator(schema).iter_errors(request)), "DOMAIN_REQUEST_SCHEMA")
    require(request["contract_sha256"] == CONTRACT_SHA256
            and request["subject"] == contract["subject"], "DOMAIN_REQUEST_BINDING")
    require(reader is not None, "DOMAIN_AUTHORITY_NOT_CONFIGURED")
    require(getattr(reader, "mode", None) == MODE, "DOMAIN_LIVE_CAPABILITY_NOT_IMPLEMENTED")
    started_at = clock_time(clock)
    ctx = reader.authorization_context()
    fresh(ctx, clock_time(clock))
    require(ctx.get("service") == SERVICE and ctx.get("domain_admission") == "AUTHORIZED"
            and ctx.get("environment") == "NON_PRODUCTION"
            and ctx.get("action") == ACTION and ctx.get("subject") == contract["subject"],
            "DOMAIN_ACTION_NOT_AUTHORIZED")
    principal = ctx["principal"]
    require(isinstance(principal, dict) and set(principal) == {"subject_id", "binding_id"}
            and all(isinstance(value, str) and re.fullmatch(UUID, value)
                    for value in principal.values()), "DOMAIN_PRINCIPAL_SHAPE")
    # A real Owner definition adoption is a prerequisite, not a domain grant.
    adoption = contract["owner_adoption"]
    owner = current_record(reader, {"id": adoption["canonical_record_id"],
        "version": adoption["record_version"], "content_hash": adoption["record_content_sha256"]},
        clock, "decision", "user_explicit")
    require(owner.get("receipt_id") == adoption["canonical_receipt_id"], "DOMAIN_OWNER_RECEIPT_BINDING")
    grant_ref = ctx["permission_record_ref"]
    grant_row = current_record(reader, grant_ref, clock, "decision", "user_explicit")
    grant = grant_row["type_fields"].get("domain_permission")
    require(isinstance(grant, dict) and set(grant) == {"status", "revoked_at", "not_before",
        "expires_at", "action", "effect", "environment", "canonical_scope", "subject",
        "principal", "producer_registration_ref"}, "DOMAIN_PERMISSION_REQUIRED")
    require(grant.get("status") == "active" and grant.get("revoked_at") is None,
            "DOMAIN_PERMISSION_REVOKED")
    not_before, expires = timestamp(grant.get("not_before")), timestamp(grant.get("expires_at"))
    require(not_before <= clock_time(clock) < expires,
            "DOMAIN_PERMISSION_EXPIRED_OR_NOT_YET_VALID")
    require(0 < (expires - not_before).total_seconds() <= MAX_PERMISSION_WINDOW_SECONDS,
            "DOMAIN_PERMISSION_WINDOW")
    require(grant.get("action") == ACTION and grant.get("effect") == EFFECT
            and grant.get("environment") == "NON_PRODUCTION"
            and grant.get("canonical_scope") == SCOPE
            and grant.get("subject") == contract["subject"]
            and grant.get("principal") == principal, "DOMAIN_PERMISSION_SCOPE")
    producer_ref = grant["producer_registration_ref"]
    producer = current_record(reader, producer_ref, clock, "state", "user_explicit")
    require(producer["type_fields"].get("domain_producer") == {
        "service": SERVICE, "role": ROLE, "domain_owner": "MODEL PROGRAM",
        "environment": "NON_PRODUCTION", "principal": principal,
        "authority_registry_sha256": contract["authority_registry_sha256"]}, "DOMAIN_PRODUCER_REGISTRATION")
    recognition_ref = request["recognition_record_ref"]
    row = current_record(reader, recognition_ref, clock, "state", "observed")
    expected = {"contract_id": contract["contract_id"], "contract_version": contract["version"],
        "contract_sha256": CONTRACT_SHA256, "subject": contract["subject"],
        "owner_adoption": adoption, "permission_record_ref": grant_ref,
        "producer_registration_ref": producer_ref, "producer": {"service": SERVICE, **principal},
        "effect": EFFECT}
    require(row["type_fields"].get("state_kind") == "model_dataset_split_domain_recognition"
            and row["type_fields"].get("domain_recognition") == expected, "DOMAIN_RECOGNITION_BINDING")
    require(row.get("receipt_id") == request["recognition_receipt_id"], "DOMAIN_RECOGNITION_RECEIPT_BINDING")
    receipt, event = committed_receipt(reader, row, principal, clock)
    final_ctx = reader.authorization_context()
    # Sample after the final service read. Entry time is not an admission clock:
    # a read can outlive its permission or return a newer service observation.
    accepted_at = clock_time(clock)
    require(accepted_at >= started_at, "DOMAIN_CLOCK_REGRESSED")
    require(not_before <= accepted_at < expires, "DOMAIN_PERMISSION_EXPIRED_OR_NOT_YET_VALID")
    for view in (ctx, owner, grant_row, producer, row, receipt, event, final_ctx):
        fresh(view, accepted_at)
    require(digest({k:v for k,v in final_ctx.items() if k != "evaluated_at"}) ==
            digest({k:v for k,v in ctx.items() if k != "evaluated_at"}), "DOMAIN_PERMISSION_CHANGED")
    return {"status": "PASS_DOMAIN_RECOGNITION_ADAPTER_SYNTHETIC_ONLY",
        "trust_boundary": MODE, "contract_sha256": CONTRACT_SHA256,
        "canonical_record_ref": recognition_ref, "canonical_receipt_id": receipt["id"],
        "receipt_operation_family": "record_mutation", "subject": contract["subject"],
        "canonical_reference_live_check": "NOT_RUN_SYNTHETIC_DOUBLE",
        "authority_effect": "NONE", "domain_authority_receipt": "NOT_ISSUED",
        "m2_verdict": "NOT_ISSUED", "training_or_data_use_authorized": False,
        "production_enabled": False}


def validate_recognition(request, reader=None, *, clock=None):
    """Read-only adapter. Every success remains explicitly synthetic.

    `reader` and the UTC clock are Host dependencies, not JSON request fields.
    Tests inject a controllable clock; ordinary callers use the current UTC clock.
    No function here
    invokes clued_record_mutate or emits an Event/Receipt. Service failures fail
    closed with a sanitized code. Source/fixture metadata is never permission.
    """
    if clock is None:
        clock = utc_now
    source_clock = clock
    latest_sample = None

    def monotonic_clock():
        nonlocal latest_sample
        value = clock_time(source_clock)
        require(latest_sample is None or value >= latest_sample, "DOMAIN_CLOCK_REGRESSED")
        latest_sample = value
        return value

    try:
        return _validate_recognition(copy.deepcopy(request), reader, monotonic_clock)
    except FoundationError:
        raise
    except Exception:
        raise FoundationError("DOMAIN_SERVICE_UNAVAILABLE_OR_INVALID") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-domain-authority", action="store_true")
    args = parser.parse_args(argv)
    try:
        contract, _schema = validate_contract()
        require(not args.require_domain_authority, "DOMAIN_AUTHORITY_NOT_CONFIGURED")
    except (FoundationError, OSError, ValueError, KeyError, TypeError) as exc:
        code = exc.code if isinstance(exc, FoundationError) else "CLUED_MODEL_M2_INVALID_DOMAIN_CONTRACT"
        print(json.dumps({"status": "FAIL_DOMAIN_RECOGNITION_CANDIDATE", "error": code}, sort_keys=True))
        return 1
    print(json.dumps({"status": "PASS_DOMAIN_RECOGNITION_CONTRACT_ONLY",
        "contract_sha256": CONTRACT_SHA256, "subject": contract["subject"],
        "live_backend": "NOT_CONFIGURED", "domain_authority_receipt": "NOT_ISSUED",
        "authority_effect": "NONE", "m2_verdict": "NOT_ISSUED",
        "training_or_data_use_authorized": False, "production_enabled": False}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
