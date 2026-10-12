"""Pure renderer Source regressions; old public Core input, no new168 corpus."""
import builtins
import copy
import hashlib
import json
from pathlib import Path
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts/model-program"
FIXTURE_ROOT = ROOT / "tests/fixtures/model-stage-admission/core-adapter-e76"
FIXTURE = FIXTURE_ROOT / "tests/fixtures/model-program-m2/core-development-candidate.json"
SCHEMA_PATH = FIXTURE_ROOT / "development/contracts/information-flow/vendored/m0a/segment-input.v1.schema.json"
RENDERER_PATH = SCRIPTS / "development_input_renderer.py"


def private_source(name, path, dependencies=None):
    module = types.ModuleType("private_input_renderer_test." + name)
    module.__file__, module.__package__ = str(path), ""
    dependencies = dependencies or {}
    namespace = dict(vars(builtins))
    def resolve(import_name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and import_name in dependencies:
            return dependencies[import_name]
        return builtins.__import__(import_name, globals, locals, fromlist, level)
    namespace["__import__"] = resolve
    module.__dict__["__builtins__"] = namespace
    exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    return module


RUNNER = private_source("saved_runner", SCRIPTS / "saved_report_runner.py")
SCOPED = private_source("scoped_json", SCRIPTS / "validate_m2_scoped_successor.py")
S = private_source("renderer", RENDERER_PATH,
                   {"saved_report_runner": RUNNER, "validate_m2_scoped_successor": SCOPED})
SCHEMA_RAW = SCHEMA_PATH.read_bytes()
FIXTURE_RAW = FIXTURE.read_bytes()
OLD_INPUT = json.loads(FIXTURE_RAW)["samples"][0]["input"]
DECLARED_SHA = hashlib.sha256(RENDERER_PATH.read_bytes()).hexdigest()


def canonical(value):
    # Independent stdlib oracle; no S.encode/canonical_sha256/seal calls.
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def specification():
    messages = []
    for original in OLD_INPUT["messages"]:
        message = copy.deepcopy(original)
        message["content_template"] = message.pop("content")
        messages.append(message)
    return {"purpose_id": "development", "source_class": "C",
        "templates": [{"id": "public_core24_literal", "reference_time": OLD_INPUT["reference_time"],
                       "timezone": OLD_INPUT["timezone"], "messages": messages}],
        "scenarios": [{"id": OLD_INPUT["segment_id"],
            "source_ref": "e76:public_core24_regression:samples/0/input",
            "root_id": "public_root_0", "family_id": "public_family_0", "semantic_group_id": "public_group_0",
            "template_id": "public_core24_literal", "track": "utterance_card", "language": "zh",
            "risk": "ordinary", "difficulty": "direct", "variables": {}}]}


def render(spec, *, schema=SCHEMA_RAW, declared_sha=DECLARED_SHA):
    return S.render_development(canonical(spec), schema, declared_renderer_sha256=declared_sha)


def second_scenario(spec):
    second = copy.deepcopy(spec["scenarios"][0])
    for key in ("id", "root_id", "family_id", "semantic_group_id"):
        second[key] += "_second"
    second["track"] = "card_chain"
    spec["scenarios"].append(second)
    return second


def budget_spec(padding):
    spec = specification()
    first = spec["templates"][0]["messages"][0]
    first["content_template"] = "界" * 20000
    extra = copy.deepcopy(first)
    extra["message_id"] += "_extra"
    extra["evidence_id"] += "_extra"
    extra["content_template"] = padding
    spec["templates"][0]["messages"].append(extra)
    return spec


class DevelopmentInputRendererSemantics(unittest.TestCase):
    def test_date_time_format_uses_rfc_examples_and_real_calendar_boundaries(self):
        # RFC3339 sections 5.6-5.8; potential leap placement is not an event attestation.
        valid = ("1985-04-12T23:20:50.52Z", "1996-12-19T16:39:57-08:00",
                 "1990-12-31T23:59:60Z", "1990-12-31T15:59:60-08:00",
                 "1991-01-01T00:59:60+01:00", "2000-02-29t00:00:00z",
                 "0000-02-29T00:00:00-00:00", "1937-01-01T12:00:27.87+00:20")
        invalid = ("not-a-time", "1900-02-29T00:00:00Z", "2026-02-30T00:00:00Z",
                   "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z",
                   "2026-01-01T00:00:61Z", "2026-01-01T00:00:00+24:00",
                   "2026-01-01T00:00:00+00:60", "1990-12-31T12:00:60Z",
                   "1990-12-30T23:59:60Z", "2026-01-01T00:00:00", "2026-01-01T00:00:00.Z")
        for value in valid + invalid:
            with self.subTest(value=value):
                self.assertEqual(S.date_time_format(value), value in valid)

    def test_date_time_check_is_instance_local_and_reference_time_is_checked(self):
        from jsonschema import FormatChecker
        before = copy.copy(FormatChecker().checkers)
        spec = specification()
        spec["templates"][0]["reference_time"] = "2026-02-30T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "SEGMENT_SCHEMA"):
            render(spec)
        render(specification())
        self.assertEqual(FormatChecker().checkers, before)

    def test_old_public_human_input_is_preserved_exactly(self):
        self.assertEqual(hashlib.sha256(FIXTURE_RAW).hexdigest(),
                         "dc17097bd3d12c415b2496962815397a98259bb8bab4922799a7eb00d8316eba")
        packet = json.loads(render(specification()))
        self.assertEqual(packet["samples"][0]["input"], OLD_INPUT)
        self.assertEqual(packet["samples"][0]["input_sha256"], digest(OLD_INPUT))
        self.assertEqual(packet["observed_row_count"], 1)

    def test_fixed_source_spec_bytes_replay_and_caller_data_stay_stable(self):
        spec = specification()
        before = copy.deepcopy(spec)
        first, second = render(spec), render(spec)
        self.assertEqual(first, second)
        self.assertEqual(hashlib.sha256(first).digest(), hashlib.sha256(second).digest())
        self.assertEqual(spec, before)
        self.assertEqual(json.loads(first)["spec_raw_sha256"], hashlib.sha256(canonical(spec)).hexdigest())

    def test_variables_are_literal_one_pass_without_eval(self):
        spec = specification()
        literal = '{{next}} __import__("os").system("inert") {value.attr}'
        spec["templates"][0]["messages"][0]["content_template"] = "{{value}}"
        spec["scenarios"][0]["variables"] = {"value": literal}
        packet = json.loads(render(spec))
        self.assertEqual(packet["samples"][0]["input"]["messages"][0]["content"], literal)

    def test_attribute_index_and_format_template_syntax_rejected(self):
        for template in ("{{value.attr}}", "{{value[0]}}", "{{value!r}}", "{{value:03}}", "{{value"):
            spec = specification()
            spec["templates"][0]["messages"][0]["content_template"] = template
            spec["scenarios"][0]["variables"] = {"value": "inert"}
            with self.subTest(template=template), self.assertRaisesRegex(ValueError, "TEMPLATE_SYNTAX"):
                render(spec)

    def test_missing_unused_or_invalid_variable_rejected(self):
        for variables in ({}, {"value": "inert", "extra": "unused"}, {"value": False}, {"value": None}):
            spec = specification()
            spec["templates"][0]["messages"][0]["content_template"] = "{{value}}"
            spec["scenarios"][0]["variables"] = variables
            with self.subTest(variables=variables), self.assertRaises(ValueError):
                render(spec)

    def test_lineage_preserves_source_root_template_and_group(self):
        spec = specification()
        row = json.loads(render(spec))["samples"][0]
        scenario, template = spec["scenarios"][0], spec["templates"][0]
        self.assertEqual(row["declared_provenance"], {key: scenario[key] for key in
            ("source_ref", "root_id", "family_id", "semantic_group_id", "template_id", "language", "risk", "difficulty")})
        self.assertEqual(row["scenario_sha256"], digest(scenario))
        self.assertEqual(row["template_sha256"], digest(template))
        stripped = {"reference_time": OLD_INPUT["reference_time"], "timezone": OLD_INPUT["timezone"],
            "messages": [{k: v for k, v in message.items() if k not in {"message_id", "evidence_id"}}
                         for message in OLD_INPUT["messages"]]}
        self.assertEqual(row["exact_content_group_sha256"], digest(stripped))

    def test_source_template_and_behavior_changes_change_identity(self):
        baseline = json.loads(render(specification()))
        for field in ("source_ref", "language", "risk", "difficulty", "template"):
            spec = specification()
            if field == "template":
                spec["templates"][0]["messages"][0]["content_template"] += " "
            else:
                spec["scenarios"][0][field] = {"source_ref": "e76:changed-source-reference",
                    "language": "mixed", "risk": "boundary", "difficulty": "compound"}[field]
            result = json.loads(render(spec))
            with self.subTest(field=field):
                self.assertNotEqual(result["spec_raw_sha256"], baseline["spec_raw_sha256"])
                self.assertNotEqual(digest(result), digest(baseline))

    def test_global_root_family_and_group_conflicts_across_tracks(self):
        for field in ("root_id", "family_id", "semantic_group_id"):
            spec = specification()
            second = second_scenario(spec)
            second[field] = spec["scenarios"][0][field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "DUPLICATE_" + field.upper()):
                render(spec)

    def test_exact_content_collision_survives_id_and_track_renaming(self):
        spec = specification()
        second = second_scenario(spec)
        second["template_id"] = "renamed_template"
        renamed = copy.deepcopy(spec["templates"][0])
        renamed["id"] = second["template_id"]
        for message in renamed["messages"]:
            message["message_id"] += "_renamed"
            message["evidence_id"] += "_renamed"
        spec["templates"].append(renamed)
        with self.assertRaisesRegex(ValueError, "DUPLICATE_RENDERED_INPUT"):
            render(spec)

    def test_non_development_or_non_candidate_class_rejected(self):
        for purpose in ("qualification", "final_holdout", "training", "calibration_fit"):
            spec = specification()
            spec["purpose_id"] = purpose
            with self.subTest(purpose=purpose), self.assertRaisesRegex(ValueError, "PURPOSE"):
                render(spec)
        spec = specification()
        spec["source_class"] = "A"
        with self.assertRaisesRegex(ValueError, "PURPOSE"):
            render(spec)

    def test_existing_schema_rejects_malformed_message_and_shape(self):
        for field, value in (("author_role", "owner"), ("context_only", 0), ("created_at", "not-a-time")):
            spec = specification()
            spec["templates"][0]["messages"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "SEGMENT_SCHEMA"):
                render(spec)
        spec = specification()
        spec["templates"][0]["messages"][0]["caller_authority"] = True
        with self.assertRaisesRegex(ValueError, "MESSAGE_SHAPE"):
            render(spec)

    def test_duplicate_template_scenario_message_or_evidence_ids_rejected(self):
        for kind in ("template", "scenario", "message", "evidence"):
            spec = specification()
            if kind == "template":
                spec["templates"].append(copy.deepcopy(spec["templates"][0]))
            elif kind == "scenario":
                spec["scenarios"].append(copy.deepcopy(spec["scenarios"][0]))
            else:
                message = copy.deepcopy(spec["templates"][0]["messages"][0])
                if kind == "evidence":
                    message["message_id"] += "_other"
                spec["templates"][0]["messages"].append(message)
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "DUPLICATE"):
                render(spec)

    def test_invalid_utf8_duplicate_json_and_nonfinite_values_rejected(self):
        raw = canonical(specification())
        for invalid in (b"\xff", raw.replace(b'"purpose_id":"development"',
                        b'"purpose_id":"development","purpose_id":"development"')):
            with self.subTest(invalid=invalid[:20]), self.assertRaises(ValueError):
                S.render_development(invalid, SCHEMA_RAW, declared_renderer_sha256=DECLARED_SHA)
        for literal in (b"NaN", b"Infinity", b"-Infinity", b"1e999"):
            invalid = raw.replace(b'"variables":{}', b'"variables":{"value":' + literal + b'}')
            with self.subTest(literal=literal), self.assertRaises(ValueError):
                S.render_development(invalid, SCHEMA_RAW, declared_renderer_sha256=DECLARED_SHA)
        spec = specification()
        spec["templates"][0]["messages"][0]["content_template"] = "\ud800"
        with self.assertRaises(ValueError):
            S.render_development(json.dumps(spec).encode(), SCHEMA_RAW, declared_renderer_sha256=DECLARED_SHA)

    def test_true_utf8_escaped_content_exact_input_bound(self):
        # Two messages satisfy the original per-message 20000-char bound.
        # Independently compute padding needed for the fixed 65536-byte segment.
        spec = budget_spec('"\n\t\\界')
        expected = copy.deepcopy(OLD_INPUT)
        expected["messages"] = [{**{k: v for k, v in m.items() if k != "content_template"},
                                 "content": m["content_template"]} for m in spec["templates"][0]["messages"]]
        padding = 65536 - len(canonical(expected))
        self.assertGreater(padding, 0)
        spec["templates"][0]["messages"][1]["content_template"] += "x" * padding
        packet = json.loads(render(spec))
        self.assertEqual(len(canonical(packet["samples"][0]["input"])), 65536)
        spec["templates"][0]["messages"][1]["content_template"] += "x"
        with self.assertRaisesRegex(ValueError, "INPUT_BYTE_BOUND"):
            render(spec)

    def test_count_spec_and_total_packet_caps_are_real_bounds(self):
        spec = specification()
        spec["scenarios"] *= 169
        with self.assertRaisesRegex(ValueError, "COUNT"):
            render(spec)
        with self.assertRaisesRegex(ValueError, "SPEC_BYTES"):
            S.render_development(b" " * 262145, SCHEMA_RAW, declared_renderer_sha256=DECLARED_SHA)
        spec = specification()
        spec["templates"][0]["messages"][0]["content_template"] = "界" * 19000 + "{{suffix}}"
        original = spec["scenarios"][0]
        spec["scenarios"] = [{**copy.deepcopy(original), "id": "bound_" + str(i),
            "root_id": "bound_root_" + str(i), "family_id": "bound_family_" + str(i),
            "semantic_group_id": "bound_group_" + str(i), "variables": {"suffix": str(i)}} for i in range(40)]
        self.assertLess(len(canonical(spec)), 262144)
        with self.assertRaisesRegex(ValueError, "PACKET_BYTE_BOUND"):
            render(spec)

    def test_repeated_placeholder_bound_rejects_before_join(self):
        # A non-string sentinel would raise TypeError if join were reached.
        # Tiny size spy makes the second substitution exceed a five-byte budget.
        sentinel = object()
        def size(value):
            return 4 if value is sentinel else 2
        with mock.patch.object(S, "json_string_size", side_effect=size):
            with self.assertRaisesRegex(ValueError, "INPUT_BYTE_BOUND"):
                S.substitute("{{value}}{{value}}", {"value": sentinel}, set(), 5)

    def test_gold_fields_rejected_and_output_has_no_measurement_or_qualification(self):
        for key in ("gold", "true_label", "correct", "probabilities", "domain_authority_receipt"):
            spec = specification()
            spec["scenarios"][0][key] = True
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "SCENARIO_SHAPE"):
                render(spec)
        packet = json.loads(render(specification()))
        self.assertIsNone(packet["gold"])
        self.assertIsNone(packet["effective_independent_sample_count"])
        self.assertEqual(packet["authority_effect"], "NONE")
        self.assertEqual(packet["m2_verdict"], "NOT_ISSUED")
        self.assertEqual(packet["model_calls"], 0)
        self.assertEqual(packet["semantic_dedup"], "NOT_PERFORMED")
        def inspect(value):
            if isinstance(value, dict):
                self.assertFalse(set(value) & {"true_label", "correct", "probabilities", "qualification"})
                for child in value.values():
                    inspect(child)
            elif isinstance(value, list):
                for child in value:
                    inspect(child)
        inspect(packet)

    def test_pinned_schema_declared_source_format_and_no_io_writer(self):
        for schema, declared in ((SCHEMA_RAW + b" ", DECLARED_SHA), (SCHEMA_RAW, False),
                                 (SCHEMA_RAW, "not-a-sha")):
            with self.subTest(declared=declared), self.assertRaises(ValueError):
                render(specification(), schema=schema, declared_sha=declared)
        calls = []
        def forbidden(*args, **kwargs):
            calls.append(True)
            raise AssertionError("renderer must not open a file")
        # Only this private module's builtins dictionary, never process globals.
        with mock.patch.dict(S.__dict__["__builtins__"], {"open": forbidden}):
            packet = json.loads(render(specification()))
        self.assertEqual(calls, [])
        self.assertFalse(hasattr(S, "main"))
        self.assertEqual(packet["declared_renderer_sha256"], DECLARED_SHA)


if __name__ == "__main__":
    unittest.main()
