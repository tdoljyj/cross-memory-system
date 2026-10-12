"""Deterministic candidate inputs from caller-admitted development specifications.

No default scenarios, labels, model calls, file writer, CLI, split assignment or
authority issuer. A caller must admit actual data use and verify Source/Schema
and template/scenario identities before calling. This local packet is not a
DatasetSplit instance, formal TaskSpec, new Consumer/Role or admission receipt.
In particular, caller strings and hashes never prove authorization or Gold.
The original frozen Core24 generator/scorer remains unchanged.
"""
import copy
import calendar
import hashlib
import json
import re

from jsonschema import Draft202012Validator, FormatChecker
from saved_report_runner import canonical_sha256
from validate_m2_scoped_successor import strict_json


SEGMENT_SCHEMA_SHA256 = "a4f174a56a3e53bad8c72ba0e888bd012164542920df293466c2e711aaece865"
TRACKS = {"utterance_card", "card_chain", "imprint", "context",
          "decision.semantic_relation", "decision.context_relevance", "decision.processing_route"}
MAX_SPEC_BYTES = 262144
MAX_CASES = 168
MAX_INPUT_BYTES = 65536
MAX_PACKET_BYTES = 2097152
TOKEN = re.compile(r"\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}")
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
DATE_TIME = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]"
                       r"([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?"
                       r"([Zz]|[+-][0-9]{2}:[0-9]{2})\Z")


def require(condition, code):
    if not condition:
        raise ValueError("DEVELOPMENT_INPUT_" + code)


def exact(value, keys, code):
    require(type(value) is dict and set(value) == set(keys), code)


def identifier(value):
    require(type(value) is str and ID.fullmatch(value) is not None, "IDENTIFIER")
    return value


def text(value):
    require(type(value) is str and bool(value), "TEXT")
    value.encode("utf-8", errors="strict")
    return value


def raw_sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    # Reuse existing finite/type-strict local JSON semantics, not a new JCS rule.
    canonical_sha256(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def date_time_format(value):
    """RFC3339 syntax/calendar check, not evidence of a real event or clock.

    Local instance-only checker avoids jsonschema's optional-dependency silent
    acceptance. Potential leap seconds must fall at UTC month-end 23:59; an
    actual leap-second announcement/event still needs separate real evidence.
    """
    if type(value) is not str:
        return True  # Existing Schema enforces string type separately.
    match = DATE_TIME.fullmatch(value)
    if match is None:
        return False
    year, month, day, hour, minute, second = map(int, match.groups()[:6])
    if not (1 <= month <= 12 and 1 <= day <= calendar.monthrange(year, month)[1] and
            hour <= 23 and minute <= 59 and second <= 60):
        return False
    offset = match[7]
    delta = 0
    if offset not in {"Z", "z"}:
        offset_hour, offset_minute = int(offset[1:3]), int(offset[4:6])
        if offset_hour > 23 or offset_minute > 59:
            return False
        delta = (offset_hour * 60 + offset_minute) * (1 if offset[0] == "+" else -1)
    if second == 60:
        utc_minute = hour * 60 + minute - delta
        if utc_minute % 1440 != 1439:
            return False
        day += utc_minute // 1440
        if day == 0:
            month -= 1
            if month == 0:
                year, month = year - 1, 12
            day = calendar.monthrange(year, month)[1]
        elif day > calendar.monthrange(year, month)[1]:
            month += 1
            if month == 13:
                year, month = year + 1, 1
            day = 1
        return day == calendar.monthrange(year, month)[1]
    return True


def json_string_size(value):
    return len(encode(value))


def substitute(template, variables, used, max_json_bytes):
    text(template)
    # Only named placeholders: no Python expression, attribute/index access,
    # recursive expansion or format mini-language. Braces inside substituted
    # values remain literal and cannot introduce a second evaluation pass.
    pieces, size, cursor = [], 2, 0  # JSON string quotes.
    for match in TOKEN.finditer(template):
        literal = template[cursor:match.start()]
        require("{{" not in literal and "}}" not in literal, "TEMPLATE_SYNTAX")
        name = match.group(1)
        require(name in variables, "MISSING_VARIABLE")
        used.add(name)
        value = variables[name]
        # Check escaped UTF-8 size BEFORE joining repeated values. A tiny
        # repeated placeholder cannot allocate an unbounded expanded string.
        size += json_string_size(literal) - 2 + json_string_size(value) - 2
        require(size <= max_json_bytes, "INPUT_BYTE_BOUND")
        pieces.extend((literal, value))
        cursor = match.end()
    tail = template[cursor:]
    require("{{" not in tail and "}}" not in tail, "TEMPLATE_SYNTAX")
    size += json_string_size(tail) - 2
    require(size <= max_json_bytes, "INPUT_BYTE_BOUND")
    pieces.append(tail)
    return "".join(pieces)


def render_development(spec_raw, segment_schema_raw, *, declared_renderer_sha256):
    """Return a local candidate packet; actual materialization requires the caller's gate.

    spec is strict UTF-8 JSON: purpose_id, source_class, templates, scenarios.
    templates carry id, reference_time, timezone, messages. Messages have the
    existing Segment fields with content_template in place of content.
    scenarios carry id, source_ref, root_id, family_id, semantic_group_id,
    template_id, track, language, risk, difficulty, variables. All provenance
    classifications are caller declarations; semantic dedup and rights remain
    unverified here. declared_renderer_sha256 is explicitly not code attestation.
    """
    require(type(spec_raw) is bytes and len(spec_raw) <= MAX_SPEC_BYTES, "SPEC_BYTES")
    require(type(segment_schema_raw) is bytes and
            raw_sha(segment_schema_raw) == SEGMENT_SCHEMA_SHA256, "SEGMENT_SCHEMA_BYTES")
    require(type(declared_renderer_sha256) is str and
            SHA.fullmatch(declared_renderer_sha256) is not None, "DECLARED_RENDERER_SHA")
    spec = strict_json(spec_raw)
    exact(spec, {"purpose_id", "source_class", "templates", "scenarios"}, "SPEC_SHAPE")
    require(spec["purpose_id"] == "development" and spec["source_class"] == "C", "PURPOSE")
    require(type(spec["templates"]) is list and 1 <= len(spec["templates"]) <= MAX_CASES and
            type(spec["scenarios"]) is list and 1 <= len(spec["scenarios"]) <= MAX_CASES, "COUNT")
    schema = strict_json(segment_schema_raw)
    Draft202012Validator.check_schema(schema)
    checker = FormatChecker(formats=())
    checker.checks("date-time")(date_time_format)
    validator = Draft202012Validator(schema, format_checker=checker)
    templates = {}
    for template in spec["templates"]:
        exact(template, {"id", "reference_time", "timezone", "messages"}, "TEMPLATE_SHAPE")
        key = identifier(template["id"])
        require(key not in templates, "DUPLICATE_TEMPLATE")
        require(type(template["messages"]) is list and 1 <= len(template["messages"]) <= 64, "MESSAGES")
        for message in template["messages"]:
            exact(message, {"message_id", "evidence_id", "author_role", "created_at",
                            "context_only", "content_template"}, "MESSAGE_SHAPE")
            text(message["content_template"])
            text(message["message_id"])
            text(message["evidence_id"])
        templates[key] = template

    packet = {"artifact_kind": "LOCAL_DEVELOPMENT_INPUT_CANDIDATE", "purpose_id": "development",
        "source_class": "C", "spec_raw_sha256": raw_sha(spec_raw),
        "segment_schema_raw_sha256": SEGMENT_SCHEMA_SHA256,
        "declared_renderer_sha256": declared_renderer_sha256,
        "samples": [], "observed_row_count": len(spec["scenarios"]), "effective_independent_sample_count": None,
        "exposure": "AUTHOR_VISIBLE_DEVELOPMENT_NOT_UNSEEN",
        "semantic_dedup": "NOT_PERFORMED", "rights_and_privacy": "NOT_ATTESTED_HERE",
        "workflow_task_spec": "NOT_ADMITTED_HERE", "gold": None, "authority_effect": "NONE",
        "m2_verdict": "NOT_ISSUED", "model_calls": 0}
    packet_size = len(encode(packet))
    rows, seen_ids, seen_roots, seen_families, seen_groups, seen_inputs, used_templates = [], set(), set(), set(), set(), set(), set()
    for scenario in spec["scenarios"]:
        exact(scenario, {"id", "source_ref", "root_id", "family_id", "semantic_group_id",
                         "template_id", "track", "language", "risk", "difficulty", "variables"}, "SCENARIO_SHAPE")
        for field, seen in (("id", seen_ids), ("root_id", seen_roots),
                            ("family_id", seen_families), ("semantic_group_id", seen_groups)):
            value = identifier(scenario[field])
            require(value not in seen, "DUPLICATE_" + field.upper())
            seen.add(value)
        text(scenario["source_ref"])
        require(all(type(scenario[key]) is str for key in ("track", "language", "risk", "difficulty")) and
                scenario["track"] in TRACKS and scenario["language"] in {"zh", "en", "mixed"} and
                scenario["risk"] in {"ordinary", "boundary"} and
                scenario["difficulty"] in {"direct", "compound"}, "CLASSIFICATION")
        template_id = identifier(scenario["template_id"])
        require(template_id in templates, "MISSING_TEMPLATE")
        used_templates.add(template_id)
        template = templates[template_id]
        variables = scenario["variables"]
        require(type(variables) is dict and len(variables) <= 64, "VARIABLES")
        for key, value in variables.items():
            require(type(key) is str and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key) is not None,
                    "VARIABLE_NAME")
            text(value)
        segment = {"schema_version": "segment_input.v1", "segment_id": scenario["id"],
                   "reference_time": template["reference_time"], "timezone": template["timezone"],
                   "messages": []}
        input_size = len(encode(segment))
        require(input_size <= MAX_INPUT_BYTES, "INPUT_BYTE_BOUND")
        used, messages = set(), []
        for source in template["messages"]:
            message = {key: copy.deepcopy(value) for key, value in source.items() if key != "content_template"}
            message["content"] = ""
            fixed_size = len(encode(message)) - 2 + bool(messages)
            content_budget = MAX_INPUT_BYTES - input_size - fixed_size
            require(content_budget >= 2, "INPUT_BYTE_BOUND")
            message["content"] = substitute(source["content_template"], variables, used, content_budget)
            input_size += fixed_size + json_string_size(message["content"])
            messages.append(message)
        require(used == set(variables), "UNUSED_VARIABLE")
        require(len({m["message_id"] for m in messages}) == len(messages) and
                len({m["evidence_id"] for m in messages}) == len(messages), "DUPLICATE_MESSAGE_ID")
        segment["messages"] = messages
        require(not list(validator.iter_errors(segment)), "SEGMENT_SCHEMA")
        raw_input = encode(segment)
        require(len(raw_input) == input_size and len(raw_input) <= MAX_INPUT_BYTES, "INPUT_BYTE_BOUND")
        # Ignore renamable segment/message/evidence IDs for exact-content grouping.
        signature = canonical_sha256({"reference_time": segment["reference_time"], "timezone": segment["timezone"],
            "messages": [{k: v for k, v in message.items() if k not in {"message_id", "evidence_id"}}
                         for message in messages]})
        require(signature not in seen_inputs, "DUPLICATE_RENDERED_INPUT")
        seen_inputs.add(signature)
        row = {"id": scenario["id"], "purpose_id": "development", "track": scenario["track"],
            "input": segment, "input_sha256": raw_sha(raw_input),
            "declared_provenance": {key: copy.deepcopy(scenario[key]) for key in
                ("source_ref", "root_id", "family_id", "semantic_group_id", "template_id", "language", "risk", "difficulty")},
            "scenario_sha256": canonical_sha256(scenario), "template_sha256": canonical_sha256(template),
            "exact_content_group_sha256": signature}
        packet_size += len(encode(row)) + bool(rows)
        require(packet_size <= MAX_PACKET_BYTES, "PACKET_BYTE_BOUND")
        rows.append(row)
    require(used_templates == set(templates), "UNUSED_TEMPLATE")
    rows.sort(key=lambda row: row["id"])
    packet["samples"] = rows
    raw_packet = encode(packet)
    require(len(raw_packet) == packet_size and len(raw_packet) <= MAX_PACKET_BYTES, "PACKET_BYTE_BOUND")
    return raw_packet
