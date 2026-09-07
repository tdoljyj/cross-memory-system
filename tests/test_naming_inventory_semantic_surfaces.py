"""Syntax observations must expose omissions without asserting semantic completeness."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('naming_semantic_scanner', ROOT / 'scripts/clued-naming-surface-inventory.py')
scanner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scanner)


def observe(text, path='apps/example/worker.ts', **kwargs):
    result = scanner.new_typed_surface_inventory()
    scanner.collect_typed_surfaces(text, path, result, **kwargs)
    return scanner.finalize_typed_surface_inventory(result)


class SemanticSurfaceTests(unittest.TestCase):
    def test_actual_worker_routes_and_scopes_are_observed(self):
        path = 'apps/clued-cloud/worker/continuity.ts'
        result = observe((ROOT / path).read_text(encoding='utf-8'), path)
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'/v1/projects', '/healthz', '/mcp', '/api/bindings',
                         'context:read', 'context:write', 'audit:read', 'clued_mcp_restore'} <= names)
        self.assertTrue(all(r['observation_only'] for r in result['records']))
        self.assertEqual(result['semantic_completeness'], 'NOT_PROVEN')

    def test_route_literal_prefix_is_not_a_resolved_dynamic_route(self):
        result = observe('router.get("/private/" + tenant, handler);\napp.get(routeName, handler);')
        self.assertFalse(any(r['surface_kind'] == 'http_route' for r in result['records']))
        self.assertEqual(len([r for r in result['unresolved'] if r['rule_id'] == 'code_routes']), 2)

    def test_comments_and_quoted_examples_do_not_create_route_declarations(self):
        result = observe('// app.get("/comment", fn);\nconst example = \'app.get("/example", fn)\';\napp.get("/actual", fn);')
        self.assertEqual([r['current_name'] for r in result['records'] if r['surface_kind'] == 'http_route'], ['/actual'])

    def test_modules_multiline_exports_and_dynamic_import_are_distinct(self):
        result = observe('import {\n Thing, Other\n} from "./types";\nexport { Thing as PublicThing };\nexport * from "./public";\nconst a = import(prefix + name);')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'./types', './public', 'PublicThing'} <= names)
        self.assertTrue(any(r['rule_id'] == 'module_references' for r in result['unresolved']))

    def test_rpc_map_spread_remains_an_unresolved_binding(self):
        result = observe('const rpcByTool = { fetch: "read_records", ...otherRpc };\nclient.rpc(dynamicRpc);')
        self.assertIn('read_records', {r['current_name'] for r in result['records']})
        reasons = {r['reason'] for r in result['unresolved']}
        self.assertIn('RPC_MAP_SPREAD_REQUIRES_BINDING', reasons)
        self.assertIn('DYNAMIC_OR_UNSUPPORTED_EXPRESSION', reasons)

    def test_json_scalar_array_and_schema_enum_names(self):
        result = observe(json.dumps({'role': 'reviewer', 'scope': 'project:clued',
            'capabilities': ['memory.read', 'memory.write'],
            'properties': {'role': {'enum': ['author', 'reviewer']}}}), 'contracts/access.schema.json')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'reviewer', 'author', 'project:clued', 'memory.read', 'memory.write'} <= names)
        self.assertTrue(any(r['pointer'] == '/capabilities/1' for r in result['records']))

    def test_package_script_dependency_and_exports_names(self):
        result = observe(json.dumps({'name': 'sample-package', 'scripts': {'check:names': 'node check.js'},
            'dependencies': {'vendor-sdk': '1.2.3'}, 'exports': {'./client': './dist/client.js'}}), 'apps/sample/package.json')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'sample-package', 'check:names', 'vendor-sdk', './client', './dist/client.js'} <= names)

    def test_unread_or_invalid_selected_sources_are_not_empty_successes(self):
        result = observe(None, 'apps/sample/package.json', read_error='SIZE_LIMIT')
        coverage = next(r for r in result['rule_coverage'] if r['rule_id'] == 'package_entries')
        self.assertEqual((coverage['selected_file_count'], coverage['examined_file_count']), (1, 0))
        self.assertEqual(result['status'], 'OBSERVED_WITH_UNRESOLVED')
        invalid = observe('{broken', 'apps/sample/package.json')
        self.assertTrue(any(r['reason'] == 'JSON_PARSE_ERROR' for r in invalid['unresolved']))

    def test_zero_matches_and_unsupported_language_never_prove_absence(self):
        result = observe('const value = 42;')
        self.assertEqual(result['semantic_completeness'], 'NOT_PROVEN')
        self.assertEqual(result['status'], 'OBSERVED_REQUIRES_RULESET_REVIEW')
        unsupported = observe('package main', 'apps/main.go')
        self.assertIn('NO_TYPED_EXTRACTOR_FOR_LANGUAGE', {r['reason'] for r in unsupported['unresolved']})

    def test_python_import_and_sql_definition(self):
        result = observe('from .worker import handle\nimport json\n# app.get("/fake", fn)\n', 'scripts/main.py')
        self.assertTrue({'.worker', 'json'} <= {r['current_name'] for r in result['records']})
        self.assertFalse(any(r['surface_kind'] == 'http_route' for r in result['records']))
        sql = observe('-- CREATE TABLE ignored(x int);\nCREATE OR REPLACE FUNCTION public.read_record() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;', 'apps/migration.sql')
        self.assertEqual([r['current_name'] for r in sql['records']], ['public.read_record'])

    def test_configuration_literal_and_dynamic_are_separate(self):
        toml = observe('name = "worker"\n[[bindings]]\nname = "DATA"\n', 'apps/wrangler.toml')
        self.assertTrue({'worker', 'DATA'} <= {r['current_name'] for r in toml['records']})
        yaml = observe('name: inventory\nscope: ${{ inputs.scope }}\n', '.github/workflows/check.yml')
        self.assertIn('inventory', {r['current_name'] for r in yaml['records']})
        self.assertTrue(yaml['unresolved'])

    def test_comparisons_are_literals_and_do_not_become_assignments(self):
        result = observe('if (record.scope === "project" && role == "reader") {}\nconst scope = incoming.scope;')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'project', 'reader'} <= names)
        self.assertEqual(len(result['unresolved']), 1)

    def test_python_ast_ignores_type_only_and_quoted_examples(self):
        result = observe('''from typing import Set
example = """scopes = made_up
scope: fake_annotation"""
scopes: Set[str]
role: str = "reader"
def check(scope: str = None):
    return scope == "project"
scopes = {"memory:read", "memory:write"}
request(scope=record.scope)
''', 'scripts/example.py')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'reader', 'project', 'memory:read', 'memory:write'} <= names)
        self.assertEqual(len(result['unresolved']), 1)
        self.assertEqual(result['unresolved'][0]['line'], 9)

    def test_rpc_helper_name_argument_follows_declared_parameter(self):
        result = observe('async function rpc(client, name, token) {}\nawait rpc(owner, "read_records", token);\nawait rpc(owner, dynamicName, token);\nclient.rpc("direct_rpc");')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'read_records', 'direct_rpc'} <= names)
        self.assertEqual(len(result['unresolved']), 1)
        unknown = observe('function rpc(client, target) {}\nrpc(owner, "guess_forbidden");')
        self.assertNotIn('guess_forbidden', {r['current_name'] for r in unknown['records']})
        self.assertIn('RPC_HELPER_SIGNATURE_REQUIRES_BINDING', {r['reason'] for r in unknown['unresolved']})

    def test_typed_scope_array_is_a_type_reference_only(self):
        result = observe('interface Policy { scopes: readonly Scope[]; }\nconst scopes = runtimeScopes;')
        self.assertTrue(any(r['surface_kind'] == 'type_reference' and r['current_name'] == 'Scope' for r in result['records']))
        self.assertEqual(len(result['unresolved']), 1)

    def test_actual_inline_schemas_keep_enum_names_and_constraint_pattern(self):
        p5 = observe((ROOT / 'apps/clued-cloud/worker/p5.ts').read_text(encoding='utf-8'))
        names = {r['current_name'] for r in p5['records']}
        self.assertTrue({'owner', 'admin', 'editor', 'reader', 'denied', 'canonical:read', 'project:write'} <= names)
        self.assertFalse(any(r['rule_id'] == 'role_capability_scope' for r in p5['unresolved']))
        records = observe((ROOT / 'apps/clued-cloud/worker/records.ts').read_text(encoding='utf-8'))
        self.assertTrue(any(r['surface_kind'] == 'name_constraint_pattern' and r['extraction'] == 'pattern' for r in records['records']))

    def test_compound_capability_keys_are_not_a_json_string_name(self):
        result = observe('const value = {capabilities: {persistent_versions: true, event_rollup: false}, scope: {read_fields: ["status"]}};')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'persistent_versions', 'event_rollup', 'status'} <= names)
        self.assertFalse(result['unresolved'])
        self.assertTrue(all(not name.startswith('{') for name in names))
        dynamic = observe('const value = {capabilities: {known: true, ...computed}};')
        self.assertTrue(dynamic['unresolved'])

    def test_python_compound_scope_is_observed_as_fields(self):
        result = observe('request(scope={"mode": "current", "project_id": None})', 'scripts/example.py')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'mode', 'current', 'project_id'} <= names)
        self.assertFalse(result['unresolved'])

    def test_mixed_capability_object_preserves_keys_and_isolates_dynamic_values(self):
        result = observe('const value = {capabilities: {known: true, nested: {enabled: env ? enabled(env) : false, levels: ["global", "project"]}}};')
        names = {r['current_name'] for r in result['records']}
        self.assertTrue({'known', 'nested', 'enabled', 'levels', 'global', 'project'} <= names)
        self.assertEqual(len(result['unresolved']), 1)
        self.assertEqual(result['unresolved'][0]['reason'], 'DYNAMIC_COMPOUND_NAME_FIELD')
        self.assertEqual(result['unresolved'][0]['pointer'], '/capabilities/nested/enabled')

    def test_python_parameter_defaults_are_actual_name_definitions(self):
        result = observe('def check(scope="global", *, capability="AUDIT", role=None):\n    pass\n', 'scripts/example.py')
        self.assertEqual({r['current_name'] for r in result['records']}, {'global', 'AUDIT'})
        self.assertFalse(result['unresolved'])


if __name__ == '__main__':
    unittest.main()
