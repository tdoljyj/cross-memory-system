"""Pure, non-sendable projection into the existing ModelInvocationRequest v2.

The caller supplies lawful already-produced development bytes and verifies the
Source/consumer. Schema validity is syntax only: it supplies no Profile, consent,
classification, Host, transport or authority. Input digest covers the original
renderer-defined Segment JSON text, not a transformed provider payload.
"""
import copy
import hashlib
import json

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry

from development_input_renderer import encode, date_time_format, identifier, TRACKS
from saved_report_runner import canonical_sha256
from validate_m2_scoped_successor import strict_json


REQUEST_SCHEMA_SHA256 = "4fe9f38171a925497631ff4bf59f06d6aed9db2d296a31f159a7e8f9f5f5f642"
SEGMENT_SCHEMA_SHA256 = "a4f174a56a3e53bad8c72ba0e888bd012164542920df293466c2e711aaece865"
MAX_PACKET_BYTES = 2097152
MAX_REQUEST_BYTES = 262144
MAX_INPUT_BYTES = 65536
MAX_CASES = 168
PACKET_KEYS = {"artifact_kind", "purpose_id", "source_class", "spec_raw_sha256",
    "segment_schema_raw_sha256", "declared_renderer_sha256", "samples", "observed_row_count",
    "effective_independent_sample_count", "exposure", "semantic_dedup", "rights_and_privacy",
    "workflow_task_spec", "gold", "authority_effect", "m2_verdict", "model_calls"}
ROW_KEYS = {"id", "purpose_id", "track", "input", "input_sha256", "declared_provenance",
            "scenario_sha256", "template_sha256", "exact_content_group_sha256"}
PROVENANCE_KEYS = {"source_ref", "root_id", "family_id", "semantic_group_id", "template_id",
                   "language", "risk", "difficulty"}


def require(value, code):
    if not value:
        raise ValueError("DEVELOPMENT_REQUEST_" + code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def checked_sha(value):
    require(type(value) is str and len(value) == 64 and
            all(c in "0123456789abcdef" for c in value), "SHA256")


def packet_json(raw):
    require(type(raw) is bytes and len(raw) <= MAX_PACKET_BYTES, "PACKET_BYTES")
    # Reuse the original parser for every normal-sized packet. The existing
    # renderer permits up to2MiB; the same strict JSON rules extend only this
    # local byte carrier, without altering the old parser/global byte bound.
    if len(raw) <= MAX_REQUEST_BYTES:
        return strict_json(raw)
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    def nonfinite(_value):
        raise ValueError("DEVELOPMENT_REQUEST_NONFINITE_JSON")
    return json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                      parse_constant=nonfinite)


def deny_remote(reference):
    raise ValueError("DEVELOPMENT_REQUEST_EXTERNAL_SCHEMA_REFERENCE")


def validator(raw, pin, schema_id):
    require(type(raw) is bytes and sha(raw) == pin, "SCHEMA_PIN")
    schema = strict_json(raw)
    require(schema.get("$id") == schema_id, "SCHEMA_ID")
    Draft202012Validator.check_schema(schema)
    checker = FormatChecker(formats=())
    checker.checks("date-time")(date_time_format)
    return schema, Draft202012Validator(schema, format_checker=checker,
                                        registry=Registry(retrieve=deny_remote))


def validate_packet(packet_raw, sample_id, expected_sample_ids, segment_validator):
    require(type(expected_sample_ids) is list and 1 <= len(expected_sample_ids) <= MAX_CASES,
            "EXPECTED_IDS")
    for value in expected_sample_ids:
        identifier(value)
    require(len(set(expected_sample_ids)) == len(expected_sample_ids), "EXPECTED_DUPLICATE_ID")
    identifier(sample_id)
    packet = packet_json(packet_raw)
    require(type(packet) is dict and set(packet) == PACKET_KEYS, "PACKET_SHAPE")
    constants = {"artifact_kind": "LOCAL_DEVELOPMENT_INPUT_CANDIDATE", "purpose_id": "development",
        "source_class": "C", "exposure": "AUTHOR_VISIBLE_DEVELOPMENT_NOT_UNSEEN",
        "semantic_dedup": "NOT_PERFORMED", "rights_and_privacy": "NOT_ATTESTED_HERE",
        "workflow_task_spec": "NOT_ADMITTED_HERE", "gold": None,
        "effective_independent_sample_count": None, "authority_effect": "NONE",
        "m2_verdict": "NOT_ISSUED"}
    require(all(packet[k] == value for k, value in constants.items()), "PACKET_SCOPE")
    require(type(packet["model_calls"]) is int and packet["model_calls"] == 0, "PACKET_MODEL_CALLS")
    for field in ("spec_raw_sha256", "segment_schema_raw_sha256", "declared_renderer_sha256"):
        checked_sha(packet[field])
    require(packet["segment_schema_raw_sha256"] == SEGMENT_SCHEMA_SHA256, "PACKET_SCHEMA_PIN")
    rows = packet["samples"]
    require(type(rows) is list and 1 <= len(rows) <= MAX_CASES and
            type(packet["observed_row_count"]) is int and packet["observed_row_count"] == len(rows),
            "PACKET_COUNT")
    require(all(type(row) is dict and set(row) == ROW_KEYS for row in rows), "ROW_SHAPE")
    require([row["id"] for row in rows] == expected_sample_ids, "EXACT_EXPECTED_IDS_ORDER")
    require(sample_id in expected_sample_ids, "SAMPLE_ID")
    selected = None
    for row in rows:
        require(row["purpose_id"] == "development" and type(row["track"]) is str and
                row["track"] in TRACKS, "ROW_SCOPE")
        provenance = row["declared_provenance"]
        require(type(provenance) is dict and set(provenance) == PROVENANCE_KEYS, "PROVENANCE_SHAPE")
        for field in PROVENANCE_KEYS:
            require(type(provenance[field]) is str and bool(provenance[field]), "PROVENANCE_TEXT")
            provenance[field].encode("utf-8", errors="strict")
        for field in ("root_id", "family_id", "semantic_group_id", "template_id"):
            identifier(provenance[field])
        require(provenance["language"] in {"zh", "en", "mixed"} and
                provenance["risk"] in {"ordinary", "boundary"} and
                provenance["difficulty"] in {"direct", "compound"}, "PROVENANCE_CLASS")
        for field in ("input_sha256", "scenario_sha256", "template_sha256", "exact_content_group_sha256"):
            checked_sha(row[field])
        segment = row["input"]
        require(not list(segment_validator.iter_errors(segment)), "SEGMENT_SCHEMA")
        require(segment["segment_id"] == row["id"], "SEGMENT_ID")
        input_raw = encode(segment)
        require(len(input_raw) <= MAX_INPUT_BYTES and sha(input_raw) == row["input_sha256"], "INPUT_BYTES")
        signature = {"reference_time": segment["reference_time"], "timezone": segment["timezone"],
            "messages": [{k: v for k, v in m.items() if k not in {"message_id", "evidence_id"}}
                         for m in segment["messages"]]}
        require(canonical_sha256(signature) == row["exact_content_group_sha256"], "CONTENT_GROUP_DIGEST")
        if row["id"] == sample_id:
            selected = (row, input_raw)
    return packet, selected


def request_projection(fields, schema, request_validator, input_digest):
    require(type(fields) is dict and set(fields) <= set(schema["properties"]), "REQUEST_FIELDS")
    require(len(encode(fields)) <= MAX_REQUEST_BYTES, "REQUEST_BYTE_BOUND")
    fixed = {"object_type": "ModelInvocationRequest", "schema_version": "2.0",
             "purpose": "development", "training_mode": "none",
             "training_opt_in_receipt_ref": None, "input_digest": input_digest}
    for key, value in fixed.items():
        if key in fields:
            require(fields[key] == value or (fields[key] is None and value is not None), "FIXED_" + key.upper())
    projection = {key: copy.deepcopy(fields.get(key)) for key in schema["required"]}
    projection.update(fixed)
    missing = []
    for key, field_schema in schema["properties"].items():
        value = projection[key]
        if key == "training_opt_in_receipt_ref":
            continue
        if value is None:
            missing.append(key)
            continue
        if key == "budgets":
            require(type(value) is dict and set(value) <= set(field_schema["properties"]), "BUDGET_FIELDS")
            expanded = {k: copy.deepcopy(value.get(k)) for k in field_schema["required"]}
            projection[key] = expanded
            for budget_key, budget_schema in field_schema["properties"].items():
                budget_value = expanded[budget_key]
                if budget_value is None:
                    missing.append("budgets." + budget_key)
                else:
                    require(not list(request_validator.evolve(schema=budget_schema).iter_errors(budget_value)),
                            "INVALID_BUDGET_" + budget_key.upper())
        else:
            require(not list(request_validator.evolve(schema=field_schema).iter_errors(value)),
                    "INVALID_" + key.upper())
    if not missing:
        require(not list(request_validator.iter_errors(projection)), "REQUEST_SCHEMA")
    return projection, sorted(missing)


def project_development_request(packet_raw, sample_id, request_fields, expected_sample_ids, *,
                                request_schema_raw, segment_schema_raw):
    """Return a candidate only; even complete v2 syntax is always non-sendable."""
    schema, request_validator = validator(request_schema_raw, REQUEST_SCHEMA_SHA256,
                                          "urn:clued:schema:model-invocation-request:v2")
    _, segment_validator = validator(segment_schema_raw, SEGMENT_SCHEMA_SHA256,
                                      "https://clued.pixelgrav.com/schemas/segment-input.v1.schema.json")
    packet, (sample, input_raw) = validate_packet(packet_raw, sample_id, expected_sample_ids, segment_validator)
    projection, missing = request_projection(request_fields, schema, request_validator,
                                            "sha256:" + sha(input_raw))
    identity = {"id": sample_id, "input_sha256": sha(input_raw), "packet_raw_sha256": sha(packet_raw),
        "source_class": packet["source_class"], "purpose_id": packet["purpose_id"],
        "exposure": packet["exposure"], "sample": copy.deepcopy(sample),
        "spec_raw_sha256": packet["spec_raw_sha256"],
        "declared_renderer_sha256": packet["declared_renderer_sha256"],
        "effective_independent_sample_count": None}
    status = {"status": "INCOMPLETE" if missing else "LOCAL_SYNTAX_VALID_ONLY",
              "v2_syntax_valid": not bool(missing), "schema_sha256": REQUEST_SCHEMA_SHA256}
    seal = {"request_projection": projection, "sample_identity": identity,
            "external_inputs_required": missing, "schema_validation": status,
            "sendable": False, "authority_effect": "NONE", "qualification": "NOT_ISSUED"}
    return {**seal, "input_bytes": input_raw, "packet_raw": packet_raw,
            "projection_sha256": canonical_sha256(seal)}
