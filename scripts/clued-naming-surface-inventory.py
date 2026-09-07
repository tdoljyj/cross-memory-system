#!/usr/bin/env python3
"""Generate a fail-closed inventory of Clued naming surfaces.

This tool is intentionally read-only. It inventories tracked repository paths,
machine identifiers, version/stage tokens, path-normalization collisions, and
GitHub-owned naming surfaces. It does not rename, migrate, retire, accept, or
authorize any object.

The generated manifest is evidence for Structure Freeze preparation, not a
Structure Freeze decision and not a naming closeout.
"""

from __future__ import annotations

import argparse
import ast
from bisect import bisect_right
import datetime as dt
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tomllib
import tokenize
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path, PurePosixPath
from typing import Any

SCHEMA = "clued.naming-surface-inventory-manifest/v1"
FINDINGS_SCHEMA = "clued.naming-surface-inventory-findings/v1"
SUMMARY_SCHEMA = "clued.naming-surface-inventory-summary/v1"

TEXT_EXTENSIONS = {
    ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".env", ".go",
    ".h", ".hpp", ".html", ".ini", ".java", ".js", ".json", ".jsonl",
    ".jsx", ".md", ".mjs", ".mts", ".ps1", ".py", ".rb", ".rs", ".sh",
    ".sql", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
}
MACHINE_EXTENSIONS = {
    ".c", ".cc", ".cfg", ".conf", ".cpp", ".env", ".go", ".h", ".hpp",
    ".ini", ".java", ".js", ".json", ".jsonl", ".jsx", ".mjs", ".mts",
    ".ps1", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx",
    ".xml", ".yaml", ".yml",
}
MACHINE_PATH_PREFIXES = (
    ".github/", "scripts/", "config/", "protocol/", "schemas/", "contracts/",
    "apps/", "packages/", "adapters/", "plugins/",
)

URN_RE = re.compile(r"\burn:clued:[A-Za-z0-9._~:/#?=&%+\-]+")
CLUED_TOKEN_RE = re.compile(
    r"\bclued(?:[.@:/_-][A-Za-z0-9][A-Za-z0-9._@:/+\-]*)+", re.IGNORECASE
)
UPPER_TYPED_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+){1,}\b")
VERSION_RE = re.compile(
    r"(?<![A-Za-z0-9])v?\d+\.\d+(?:\.\d+)?(?:\.\d+)?"
    r"(?:[-+][0-9A-Za-z][0-9A-Za-z.\-]*)?(?![A-Za-z0-9])"
)
CANONICAL_STAGE_RE = re.compile(
    r"\b(?:IF-MVP0-[A-Z0-9]+|MODEL-PROGRAM-M\d+|PHASE2-CORE-SLICE-[A-Z0-9]+)\b"
)
BARE_M_STAGE_RE = re.compile(
    r"(?<![A-Za-z0-9_-])M\d+(?:-[A-Z0-9]+)?(?![A-Za-z0-9_-])"
)
BARE_SLICE_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(?:Slice|SLICE)[ _-]?[A-Z](?![A-Za-z0-9_-])"
)
COPY_SUFFIX_RE = re.compile(r"\(\d+\)(?=(?:\.[^./]+)?$)")
VAGUE_NAME_RE = re.compile(
    r"(^|[-_. ])(?:copy|copied|final|final2|new|newer|latest|old|backup|bak|temp|tmp)"
    r"(?=$|[-_. ])", re.IGNORECASE
)
DATE_TOKEN_RE = re.compile(r"(?<!\d)(?:20\d{6}|20\d{2}-\d{2}-\d{2})(?!\d)")
ID_FIELD_RE = re.compile(
    r"(?:^|_)(?:id|ref|version|revision|schema|namespace|program|stage|domain|"
    r"artifact|candidate|receipt|decision|authority|subject|source|digest|sha256)$",
    re.IGNORECASE,
)
EXPLICIT_ID_KEYS = {
    "$id", "id", "artifact_id", "record_id", "candidate_id", "decision_id",
    "receipt_id", "schema", "schema_id", "schema_version", "contract",
    "contract_id", "contract_version", "namespace", "domain_id", "program_id",
    "stage_id", "subject_ref", "source_ref", "version", "version_axis",
    "package_revision", "artifact_revision", "revision_kind", "sha256",
}

MAX_TEXT_BYTES_DEFAULT = 8 * 1024 * 1024
MAX_GITHUB_PAGES = 100

# A bounded syntax inventory, not an evaluator or a semantic-completeness claim.
TYPED_CODE_EXTENSIONS = {'.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx', '.py'}
TYPED_RULES = {
    'json_names': 'Selected name/identity fields, string arrays, and registry/manifest/schema keys in JSON.',
    'package_entries': 'package.json name, script/dependency keys and import/export entries.',
    'code_routes': 'Literal route registrations, pathname comparisons/prefixes, route-map keys and pathname regexes.',
    'code_rpc': 'Literal RPC calls, /rpc/ references and explicitly named RPC maps.',
    'module_references': 'JS/TS import/export/require module specifiers, Python imports and PowerShell module statements.',
    'role_capability_scope': 'Explicit role/capability/scope/namespace fields and literal arrays in source.',
    'config_names': 'TOML fields and selected YAML metadata; YAML anchors/dynamic values remain unresolved.',
    'sql_object_declarations': 'CREATE/ALTER/DROP schema/table/function/procedure/policy/role declarations.',
    'unsupported_language': 'Tracked source-language files without a typed extractor remain explicitly unresolved.',
}
TYPED_NAME_KEYS = {
    'name', 'names', 'namespace', 'namespaces', 'domain', 'domain_id',
    'role', 'roles', 'owner', 'owner_role', 'capability', 'capabilities',
    'scope', 'scopes', 'route', 'routes', 'rpc', 'rpcs', 'module', 'modules',
    'package', 'packages', 'consumer', 'consumer_type', 'receipt_type',
    'authorization_type', 'alias', 'aliases', 'binding', 'bindings',
}
SOURCE_STRING_RE = re.compile(r'''(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)''', re.S)


def new_typed_surface_inventory() -> dict[str, Any]:
    return {
        'schema': 'clued.naming-typed-surface-observations/v1',
        'authority_effect': 'NONE',
        'semantic_completeness': 'NOT_PROVEN',
        'status': 'OBSERVED_REQUIRES_RULESET_REVIEW',
        'scope_limit': 'Explicit syntax rules only. Dynamic values, unparsed files and unsupported forms require source-backed disposition; zero matches is not proof that a naming surface is absent.',
        'records': [], 'unresolved': [],
        'rule_coverage': {key: {'rule_id': key, 'selection': selection,
            'selected_files': [], 'examined_files': [], 'candidate_sites': 0,
            'extracted_records': 0, 'unresolved_sites': 0}
            for key, selection in TYPED_RULES.items()},
    }


def typed_rules_for_path(path: str) -> list[str]:
    p = PurePosixPath(path)
    suffix = p.suffix.lower()
    rules = []
    if suffix == '.json': rules.append('json_names')
    if p.name == 'package.json': rules.append('package_entries')
    if suffix in TYPED_CODE_EXTENSIONS:
        rules += ['code_routes', 'code_rpc', 'module_references', 'role_capability_scope']
    if suffix == '.ps1': rules.append('module_references')
    if suffix in {'.toml', '.yaml', '.yml'}: rules.append('config_names')
    if suffix == '.sql': rules.append('sql_object_declarations')
    if suffix in {'.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.go', '.rb', '.rs'}:
        rules.append('unsupported_language')
    return rules


def collect_typed_surfaces(text: str | None, path: str, inventory: dict[str, Any],
                           *, read_error: str | None = None) -> None:
    """Record literal observations and explicit unresolved syntax, never execute source."""
    selected = typed_rules_for_path(path)
    for rule in selected:
        inventory['rule_coverage'][rule]['selected_files'].append(path)

    def location(offset: int) -> dict[str, Any]:
        before = (text or '')[:offset]
        return {'path': path, 'line': before.count('\n') + 1,
                'column': offset - before.rfind('\n')}

    def unresolved(rule: str, reason: str, expression: str, offset: int = 0,
                   pointer: str | None = None) -> None:
        coverage = inventory['rule_coverage'][rule]
        coverage['unresolved_sites'] += 1
        inventory['unresolved'].append({**location(offset), 'rule_id': rule,
            'reason': reason, 'pointer': pointer,
            'expression_sha256': sha256_bytes(expression.encode('utf-8'))})

    def add(rule: str, kind: str, value: str, offset: int = 0,
            pointer: str | None = None, extraction: str = 'literal') -> None:
        inventory['rule_coverage'][rule]['extracted_records'] += 1
        inventory['records'].append({**location(offset), 'rule_id': rule,
            'surface_kind': kind, 'current_name': value, 'pointer': pointer,
            'extraction': extraction, 'observation_only': True})

    def site(rule: str) -> None:
        inventory['rule_coverage'][rule]['candidate_sites'] += 1

    if text is None:
        for rule in selected:
            unresolved(rule, read_error or 'SOURCE_NOT_READ', '')
        return
    for rule in selected:
        inventory['rule_coverage'][rule]['examined_files'].append(path)
    if 'unsupported_language' in selected:
        unresolved('unsupported_language', 'NO_TYPED_EXTRACTOR_FOR_LANGUAGE', path)

    def literal(expression: str) -> str | None:
        expression = expression.strip()
        if not SOURCE_STRING_RE.fullmatch(expression): return None
        if expression.startswith('`'):
            if '${' in expression: return None
            return expression[1:-1].replace('\\`', '`')
        try:
            value = ast.literal_eval(expression)
            return value if isinstance(value, str) else None
        except (ValueError, SyntaxError):
            return None

    def observe_expression(rule: str, kind: str, expression: str, offset: int,
                           pointer: str | None = None) -> None:
        site(rule)
        value = literal(expression)
        if value is None:
            unresolved(rule, 'DYNAMIC_OR_UNSUPPORTED_EXPRESSION', expression, offset, pointer)
        else:
            add(rule, kind, value, offset, pointer)

    class DynamicNameExpression:
        def __init__(self, expression: str, position: int):
            self.expression, self.position = expression, position

    def static_js_structure(source: str) -> Any:
        """Read literal structure; preserve executable value expressions as gaps."""
        cursor = 0
        def space() -> None:
            nonlocal cursor
            while cursor < len(source) and source[cursor].isspace(): cursor += 1
        def value() -> Any:
            nonlocal cursor
            space()
            token = SOURCE_STRING_RE.match(source, cursor)
            if token:
                parsed = literal(token.group())
                if parsed is None:
                    parsed = DynamicNameExpression(token.group(), cursor)
                cursor = token.end(); return parsed
            if source[cursor:cursor+1] in {'{', '['}:
                is_object = source[cursor] == '{'
                closing = '}' if is_object else ']'
                cursor += 1; result = {} if is_object else []
                space()
                while source[cursor:cursor+1] != closing:
                    if is_object:
                        key_token = SOURCE_STRING_RE.match(source, cursor) or re.compile(r'[A-Za-z_$][\w$]*').match(source, cursor)
                        if not key_token: raise ValueError('computed or unsupported object key')
                        key = literal(key_token.group()) if key_token.group()[0] in '\"\'`' else key_token.group()
                        if key is None: raise ValueError('dynamic object key')
                        cursor = key_token.end(); space()
                        if source[cursor:cursor+1] != ':': raise ValueError('nonliteral object entry')
                        cursor += 1
                        if key in result: raise ValueError('duplicate object key')
                        result[key] = value()
                    else: result.append(value())
                    space()
                    if source[cursor:cursor+1] == closing: break
                    if source[cursor:cursor+1] != ',': raise ValueError('expression inside literal')
                    cursor += 1; space()
                if source[cursor:cursor+1] != closing: raise ValueError('unterminated structure')
                cursor += 1; return result
            token = re.compile(r'(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b').match(source, cursor)
            if not token:
                start = cursor; depth = 0
                while cursor < len(source):
                    string = SOURCE_STRING_RE.match(source, cursor)
                    if string: cursor = string.end(); continue
                    char = source[cursor]
                    if char in '([{': depth += 1
                    elif char in ')]}':
                        if depth == 0: break
                        depth -= 1
                    elif char == ',' and depth == 0: break
                    cursor += 1
                if cursor == start or depth != 0: raise ValueError('unparsed value expression')
                return DynamicNameExpression(source[start:cursor].strip(), start)
            cursor = token.end(); return json.loads(token.group())
        result = value()
        space()
        # The container must be the assigned expression, not a prefix of a
        # conditional, property access, call, or spread-derived expression.
        if cursor < len(source) and source[cursor] not in ',;)}\r\n':
            raise ValueError('expression continues after literal')
        return result

    def structure_names(value: Any, offset: int, parts: list[str]) -> None:
        """Observe compound name keys/schema constraints without treating JSON as a name."""
        rule = 'role_capability_scope'
        if isinstance(value, dict):
            for key, child in value.items():
                key = str(key)
                pointer = json_pointer([*parts, key])
                add(rule, 'compound_name_field', key, offset, pointer)
                if isinstance(child, str) and (key in TYPED_NAME_KEYS or key in {'mode', 'level', 'const', 'pattern', 'capability_id'}):
                    add(rule, 'name_constraint_pattern' if key == 'pattern' else 'compound_name_value', child, offset, pointer,
                        extraction='pattern' if key == 'pattern' else 'literal')
                if isinstance(child, (dict, list, tuple, set)):
                    structure_names(child, offset, [*parts, key])
                elif isinstance(child, DynamicNameExpression):
                    unresolved(rule, 'DYNAMIC_COMPOUND_NAME_FIELD', child.expression, offset + child.position, pointer)
        elif isinstance(value, (list, tuple, set)):
            for i, child in enumerate(value):
                if isinstance(child, str): add(rule, 'compound_name_value', child, offset, json_pointer([*parts, str(i)]))
                elif isinstance(child, (dict, list, tuple, set)): structure_names(child, offset, [*parts, str(i)])
                elif isinstance(child, DynamicNameExpression):
                    unresolved(rule, 'DYNAMIC_COMPOUND_NAME_FIELD', child.expression, offset + child.position, json_pointer([*parts, str(i)]))

    def walk_names(value: Any, rule: str, parts: list[str] | None = None,
                   inherited_key: str | None = None, registry_keys: bool = False) -> None:
        parts = [] if parts is None else parts
        if isinstance(value, dict):
            for key, child in value.items():
                pointer = json_pointer([*parts, str(key)])
                if registry_keys:
                    site(rule); add(rule, 'registry_or_manifest_key', str(key), pointer=pointer)
                key_normal = str(key).lower().replace('-', '_')
                is_name = (key_normal in TYPED_NAME_KEYS or key_normal in EXPLICIT_ID_KEYS or bool(ID_FIELD_RE.search(key_normal))
                           or key_normal in {'enum', 'const'} and any(p in TYPED_NAME_KEYS for p in parts[-3:]))
                if is_name and isinstance(child, str):
                    site(rule); add(rule, 'named_field:'+key_normal, child, pointer=pointer)
                elif is_name and isinstance(child, list):
                    for i, item in enumerate(child):
                        if isinstance(item, str):
                            site(rule); add(rule, 'named_array:'+key_normal, item,
                                           pointer=json_pointer([*parts, str(key), str(i)]))
                        elif not isinstance(item, dict):
                            site(rule); unresolved(rule, 'NON_LITERAL_NAME_ARRAY_ITEM', repr(item), pointer=pointer+'/'+str(i))
                walk_names(child, rule, [*parts, str(key)], key_normal, registry_keys)
        elif isinstance(value, list):
            for i, child in enumerate(value):
                walk_names(child, rule, [*parts, str(i)], inherited_key, registry_keys)

    suffix = PurePosixPath(path).suffix.lower()
    if suffix == '.json':
        try: parsed = json.loads(text)
        except json.JSONDecodeError as exc:
            for rule in selected: unresolved(rule, 'JSON_PARSE_ERROR', text, exc.pos)
        else:
            registry_keys = any(word in PurePosixPath(path).name.lower() for word in ('registry', 'manifest', '.schema.'))
            walk_names(parsed, 'json_names', registry_keys=registry_keys)
            if 'package_entries' in selected and isinstance(parsed, dict):
                for key in ('name',):
                    if isinstance(parsed.get(key), str):
                        site('package_entries'); add('package_entries', 'package_name', parsed[key], pointer='/'+key)
                for key in ('scripts', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'):
                    values = parsed.get(key, {})
                    if not isinstance(values, dict):
                        site('package_entries'); unresolved('package_entries', 'PACKAGE_MAP_NOT_OBJECT', repr(values), pointer='/'+key)
                        continue
                    for name in values:
                        site('package_entries'); add('package_entries', 'package_script' if key == 'scripts' else 'package_dependency', name, pointer=json_pointer([key, name]))
                def package_targets(value: Any, parts: list[str]) -> None:
                    if isinstance(value, str):
                        site('package_entries'); add('package_entries', 'package_module_target', value, pointer=json_pointer(parts))
                    elif isinstance(value, dict):
                        for key, child in value.items():
                            site('package_entries'); add('package_entries', 'package_module_export_key', key, pointer=json_pointer([*parts, key]))
                            package_targets(child, [*parts, key])
                    elif isinstance(value, list):
                        for i, child in enumerate(value): package_targets(child, [*parts, str(i)])
                    elif value is not None:
                        site('package_entries'); unresolved('package_entries', 'UNSUPPORTED_PACKAGE_TARGET', repr(value), pointer=json_pointer(parts))
                for key in ('exports', 'imports', 'main', 'module', 'browser', 'bin'):
                    if key in parsed: package_targets(parsed[key], [key])

    if suffix == '.toml':
        try: parsed = tomllib.loads(text)
        except tomllib.TOMLDecodeError:
            unresolved('config_names', 'TOML_PARSE_ERROR', text)
        else: walk_names(parsed, 'config_names')
    if suffix in {'.yaml', '.yml'}:
        for match in re.finditer(r'(?m)^\s*(?:-\s+)?(name|role|roles|scope|scopes|capability|capabilities|namespace|binding)\s*:\s*([^\n]*)', text):
            key, expression = match.group(1), match.group(2).strip()
            site('config_names')
            if not expression or expression.startswith(('|', '>', '&', '*', '[', '{')) or '${' in expression:
                unresolved('config_names', 'YAML_NON_SCALAR_OR_DYNAMIC_NAME', expression, match.start())
            else:
                value = literal(expression)
                add('config_names', 'config_field:'+key, value if value is not None else expression.split(' #', 1)[0], match.start())
        if re.search(r'(?m)^\s*<<\s*:|[\s:]&[\w-]+', text):
            unresolved('config_names', 'YAML_MERGE_OR_ANCHOR_REQUIRES_EXPANSION', text)

    if suffix in TYPED_CODE_EXTENSIONS:
        # Mask comments but retain offsets/line numbers. Strings are retained for
        # literal extraction; dynamic expressions are recorded rather than evaluated.
        comment_re = re.compile(SOURCE_STRING_RE.pattern+r'|/\*.*?\*/|//[^\n]*', re.S)
        code = comment_re.sub(lambda m: ''.join('\n' if c == '\n' else ' ' for c in m.group())
                              if m.group().startswith(('//', '/*')) else m.group(), text)
        if suffix == '.py':
            offsets = [0]
            for line in text.splitlines(keepends=True): offsets.append(offsets[-1] + len(line))
            chars = list(text)
            python_string_spans = []
            try:
                for token in tokenize.generate_tokens(io.StringIO(text).readline):
                    if token.type in {tokenize.COMMENT, tokenize.STRING}:
                        start = offsets[token.start[0]-1] + token.start[1]
                        end = offsets[token.end[0]-1] + token.end[1]
                        if token.type == tokenize.COMMENT:
                            chars[start:end] = ' ' * (end-start)
                        else: python_string_spans.append((start, end))
            except (tokenize.TokenError, IndentationError):
                unresolved('module_references', 'PYTHON_TOKENIZATION_INCOMPLETE', text)
            code = ''.join(chars)
        string_spans = python_string_spans if suffix == '.py' else [(m.start(), m.end()) for m in SOURCE_STRING_RE.finditer(code)]
        string_starts = [start for start, _ in string_spans]
        def code_matches(pattern: str):
            for match in re.finditer(pattern, code):
                index = bisect_right(string_starts, match.start()) - 1
                if index >= 0 and string_spans[index][0] < match.start() < string_spans[index][1]:
                    continue
                yield match
        arg = r'('+SOURCE_STRING_RE.pattern+r'(?:\s*\+\s*[^,;\n)]+)?|[^,;\n)]+)'
        route_rules = [
            (r'\b(?:\w+\.)?pathname\s*(?:===|==|!==|!=)\s*'+arg, 'http_route'),
            (r'\b(?:\w+\.)?pathname\.(?:startsWith|endsWith)\(\s*'+arg, 'http_route_pattern'),
            (r'\b(?:app|router|server)\.(?:get|post|put|patch|delete|options|head|all|route)\(\s*'+arg, 'http_route'),
        ]
        for pattern, kind in route_rules:
            for match in code_matches(pattern):
                observe_expression('code_routes', kind, match.group(1), match.start(1))
        for match in code_matches('('+SOURCE_STRING_RE.pattern+r')\s*:'):
            value = literal(match.group(1))
            if value is not None and value.startswith('/'):
                site('code_routes'); add('code_routes', 'route_map_key', value, match.start(1))
        for match in code_matches(r'(/(?:\\.|[^/\n])+/[gimsuy]*)\.(?:exec|test)\(\s*(?:\w+\.)?pathname\s*\)'):
            site('code_routes'); add('code_routes', 'http_route_regex', match.group(1), match.start(1), extraction='pattern')
        # A local helper may put the RPC name after a client/id parameter. Bind
        # only a uniquely named literal parameter position; never guess first.
        rpc_declarations = list(code_matches(r'\bfunction\s+rpc\s*\(([^)]*)\)'))
        rpc_name_index = None
        if len(rpc_declarations) == 1:
            parameters = [part.strip().split('=')[0].strip() for part in rpc_declarations[0].group(1).split(',')]
            indices = [i for i, parameter in enumerate(parameters) if parameter in {'name', 'method', 'rpcName', 'rpc_name'}]
            if len(indices) == 1: rpc_name_index = indices[0]
        for match in code_matches(r'\brpc\(\s*'):
            if any(declaration.start() <= match.start() < declaration.end() for declaration in rpc_declarations): continue
            member_call = code[:match.start()].rstrip().endswith('.')
            index = 0 if member_call or not rpc_declarations else rpc_name_index
            if index is None:
                site('code_rpc'); unresolved('code_rpc', 'RPC_HELPER_SIGNATURE_REQUIRES_BINDING', code[match.start():match.end()], match.start()); continue
            cursor = match.end()
            arguments = []
            start = cursor
            depth = 0
            while cursor < len(code):
                string = SOURCE_STRING_RE.match(code, cursor)
                if string: cursor = string.end(); continue
                char = code[cursor]
                if char in '([{': depth += 1
                elif char in ')]}':
                    if char == ')' and depth == 0:
                        arguments.append((code[start:cursor], start)); break
                    depth -= 1
                elif char == ',' and depth == 0:
                    arguments.append((code[start:cursor], start)); start = cursor + 1
                    if len(arguments) > index: break
                cursor += 1
            if len(arguments) <= index:
                site('code_rpc'); unresolved('code_rpc', 'RPC_CALL_ARGUMENT_UNPARSED', code[match.end():cursor], match.end())
            else:
                expression, offset = arguments[index]
                observe_expression('code_rpc', 'rpc_name', expression, offset)
        for start, end in string_spans:
            expression = code[start:end]
            if '/rpc/' in expression:
                if suffix == '.py':
                    # Python triple-quoted strings have tokenizer-owned spans;
                    # splitting them with a JS string regex invents expressions.
                    try: value = ast.literal_eval(expression)
                    except (ValueError, SyntaxError): value = None
                    if isinstance(value, str):
                        site('code_rpc'); add('code_rpc', 'rpc_route_reference', value, start)
                    else: observe_expression('code_rpc', 'rpc_route_reference', expression, start)
                else: observe_expression('code_rpc', 'rpc_route_reference', expression, start)
        for match in code_matches(r'\b(?:const|let|var|export\s+const)\s+\w*(?:Rpc|rpc)\w*\s*(?::[^=\n]+)?=\s*\{([^}]+)\}'):
            body = match.group(1)
            for entry in re.finditer(r'[\w$]+\s*:\s*('+SOURCE_STRING_RE.pattern+r'|[^,\n]+)', body):
                observe_expression('code_rpc', 'rpc_map_target', entry.group(1), match.start(1)+entry.start(1))
            for spread in re.finditer(r'\.\.\.([^,\n]+)', body):
                site('code_rpc'); unresolved('code_rpc', 'RPC_MAP_SPREAD_REQUIRES_BINDING', spread.group(1), match.start(1)+spread.start())
        name_pattern = r'(?:role|roles|scope|scopes|capability|capabilities|namespace|namespaces)'
        for match in ([] if suffix == '.py' else code_matches(r'\b'+name_pattern+r'\s*(?::|=(?!=))\s*')):
            tail = code[match.end():]
            rule = 'role_capability_scope'
            # Type-only annotations do not assign a runtime name.
            if re.match(r'(?:string|number|boolean|unknown)\b', tail): continue
            type_reference = re.match(r'(?:readonly\s+)?([A-Z][\w$]*)\[\]\s*;', tail)
            if type_reference:
                site(rule); add(rule, 'type_reference', type_reference.group(1), match.end()); continue
            if tail.startswith(('{', '[')):
                try: compound = static_js_structure(tail)
                except (ValueError, IndexError, RecursionError): pass
                else:
                    site(rule); structure_names(compound, match.end(), [match.group().split(':', 1)[0].split('=', 1)[0].strip()]); continue
            if tail.startswith('['):
                end = tail.find(']')
                site(rule)
                if end < 0:
                    unresolved(rule, 'UNTERMINATED_NAME_ARRAY', tail[:200], match.start()); continue
                body = tail[1:end]
                for value in SOURCE_STRING_RE.finditer(body):
                    name = literal(value.group())
                    if name is None: unresolved(rule, 'DYNAMIC_NAME_ARRAY_ITEM', value.group(), match.end()+1+value.start())
                    else: add(rule, 'role_capability_scope_name', name, match.end()+1+value.start())
                remainder = SOURCE_STRING_RE.sub('', body).strip(' ,\r\n\t')
                if remainder: unresolved(rule, 'NON_LITERAL_NAME_ARRAY_ITEM', remainder, match.start())
            else:
                expression = re.match(arg, tail)
                if expression: observe_expression(rule, 'role_capability_scope_name', expression.group(1), match.end())
        if suffix != '.py':
            for match in code_matches(r'\b'+name_pattern+r'\s*(?:===|==|!==|!=)\s*('+SOURCE_STRING_RE.pattern+r')'):
                observe_expression('role_capability_scope', 'name_comparison_literal', match.group(1), match.start(1))
            for match in code_matches(r'\b(?:import|export)\s+(?:[\w$*,{}\s]+?\s+from\s*)?('+SOURCE_STRING_RE.pattern+r')'):
                observe_expression('module_references', 'module_specifier', match.group(1), match.start(1))
            for match in code_matches(r'\b(?:import|require)\(\s*'+arg):
                observe_expression('module_references', 'module_specifier', match.group(1), match.start(1))
            for match in code_matches(r'\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([\w$]+)'):
                site('module_references'); add('module_references', 'exported_symbol', match.group(1), match.start(1))
            for match in code_matches(r'\bexport\s*\{([^}]+)\}'):
                for item in match.group(1).split(','):
                    item = item.strip()
                    if not item: continue
                    site('module_references')
                    if re.fullmatch(r'[\w$]+(?:\s+as\s+[\w$]+)?', item):
                        add('module_references', 'exported_symbol', item.split()[-1], match.start(1))
                    else: unresolved('module_references', 'UNSUPPORTED_EXPORT_SPECIFIER', item, match.start(1))
        else:
            try: tree = ast.parse(text)
            except SyntaxError:
                unresolved('module_references', 'PYTHON_PARSE_ERROR', text)
            else:
                def node_offset(node: ast.AST) -> int:
                    line = text.splitlines(keepends=True)[node.lineno-1]
                    column = len(line.encode('utf-8')[:node.col_offset].decode('utf-8'))
                    return offsets[node.lineno-1] + column
                def field_name(node: ast.AST) -> str | None:
                    name = node.id if isinstance(node, ast.Name) else node.attr if isinstance(node, ast.Attribute) else node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None
                    return name if name and re.fullmatch(name_pattern, name) else None
                def python_name_value(node: ast.AST, kind: str = 'role_capability_scope_name') -> None:
                    if isinstance(node, ast.Constant) and node.value is None: return
                    if isinstance(node, ast.Dict):
                        try: compound = ast.literal_eval(node)
                        except (ValueError, TypeError): pass
                        else:
                            site('role_capability_scope'); structure_names(compound, node_offset(node), ['scope_structure']); return
                    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
                        for item in node.elts: python_name_value(item, kind)
                        return
                    expression = ast.get_source_segment(text, node) or ast.dump(node)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str):
                        site('role_capability_scope'); add('role_capability_scope', kind, node.value, node_offset(node))
                    else:
                        site('role_capability_scope'); unresolved('role_capability_scope', 'DYNAMIC_OR_UNSUPPORTED_EXPRESSION', expression, node_offset(node))
                for node in ast.walk(tree):
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        offset = sum(len(line) for line in text.splitlines(keepends=True)[:node.lineno-1])
                        names = [x.name for x in node.names] if isinstance(node, ast.Import) else ['.'*node.level+(node.module or '')]
                        for name in names:
                            site('module_references'); add('module_references', 'python_module', name, offset)
                    elif isinstance(node, ast.Assign) and any(field_name(target) for target in node.targets):
                        python_name_value(node.value)
                    elif isinstance(node, ast.AnnAssign) and field_name(node.target) and node.value is not None:
                        python_name_value(node.value)
                    elif isinstance(node, ast.keyword) and node.arg and re.fullmatch(name_pattern, node.arg):
                        python_name_value(node.value)
                    elif isinstance(node, ast.arguments):
                        positional = [*node.posonlyargs, *node.args]
                        defaults = list(zip(positional[len(positional)-len(node.defaults):], node.defaults))
                        defaults += list(zip(node.kwonlyargs, node.kw_defaults))
                        for argument, default in defaults:
                            if default is not None and re.fullmatch(name_pattern, argument.arg):
                                python_name_value(default, 'name_parameter_default')
                    elif isinstance(node, ast.Dict):
                        for key, value in zip(node.keys, node.values):
                            if key is not None and field_name(key): python_name_value(value)
                    elif isinstance(node, ast.Compare) and field_name(node.left):
                        for operator, value in zip(node.ops, node.comparators):
                            if isinstance(operator, (ast.Eq, ast.NotEq, ast.In, ast.NotIn)):
                                python_name_value(value, 'name_comparison_literal')

    if suffix == '.ps1':
        for match in re.finditer(r'(?im)\b(?:Import-Module|Export-ModuleMember)\s+(?:-(?:Name|Function|Cmdlet|Alias)\s+)?([^\r\n;]+)', text):
            expression = match.group(1).strip(); site('module_references')
            value = literal(expression)
            if value is not None or re.fullmatch(r'[\w.\\/-]+', expression):
                add('module_references', 'powershell_module_reference', value or expression, match.start(1))
            else: unresolved('module_references', 'POWERSHELL_DYNAMIC_MODULE_REFERENCE', expression, match.start(1))
    if suffix == '.sql':
        sql = re.sub(r'--[^\n]*|/\*.*?\*/', lambda m: ''.join('\n' if c == '\n' else ' ' for c in m.group()), text, flags=re.S)
        for match in re.finditer(r'(?i)\b(?:CREATE(?:\s+OR\s+REPLACE)?|ALTER|DROP)\s+(?:UNIQUE\s+)?(SCHEMA|TABLE|VIEW|FUNCTION|PROCEDURE|POLICY|ROLE|INDEX|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))*)', sql):
            site('sql_object_declarations'); add('sql_object_declarations', 'sql_'+match.group(1).lower(), match.group(2), match.start(2))


def finalize_typed_surface_inventory(inventory: dict[str, Any]) -> dict[str, Any]:
    for coverage in inventory['rule_coverage'].values():
        coverage['selected_files'] = sorted(set(coverage['selected_files']))
        coverage['examined_files'] = sorted(set(coverage['examined_files']))
        coverage['selected_file_count'] = len(coverage['selected_files'])
        coverage['examined_file_count'] = len(coverage['examined_files'])
    inventory['rule_coverage'] = list(inventory['rule_coverage'].values())
    inventory['status'] = 'OBSERVED_WITH_UNRESOLVED' if inventory['unresolved'] else 'OBSERVED_REQUIRES_RULESET_REVIEW'
    return inventory


class InventoryError(RuntimeError):
    """Raised when inventory generation cannot prove a required read."""


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run_git(repo: Path, *args: str, text: bool = True) -> str | bytes:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
        check=False,
    )
    if proc.returncode != 0:
        stderr = proc.stderr if text else proc.stderr.decode("utf-8", "replace")
        raise InventoryError(f"git {' '.join(args)} failed: {stderr.strip()}")
    return proc.stdout


def normalize_posix(path: str) -> str:
    return unicodedata.normalize("NFC", path.replace("\\", "/"))


def is_machine_surface(path: str, suffix: str) -> bool:
    return suffix in MACHINE_EXTENSIONS or path.startswith(MACHINE_PATH_PREFIXES)


def add_index(
    index: dict[str, dict[str, Any]],
    token: str,
    token_type: str,
    path: str,
    line: int,
    *,
    pointer: str | None = None,
    machine_surface: bool | None = None,
) -> None:
    entry = index.setdefault(
        token,
        {
            "token": token,
            "types": set(),
            "occurrence_count": 0,
            "locations": [],
            "locations_truncated": False,
        },
    )
    entry["types"].add(token_type)
    entry["occurrence_count"] += 1
    location: dict[str, Any] = {"path": path, "line": line}
    if pointer is not None:
        location["pointer"] = pointer
    if machine_surface is not None:
        location["machine_surface"] = machine_surface
    entry["locations"].append(location)


def json_pointer(parts: list[str]) -> str:
    if not parts:
        return ""
    escaped = [part.replace("~", "~0").replace("/", "~1") for part in parts]
    return "/" + "/".join(escaped)


def walk_json_fields(
    value: Any,
    path: str,
    out: list[dict[str, Any]],
    parts: list[str] | None = None,
) -> None:
    parts = [] if parts is None else parts
    if isinstance(value, dict):
        for key, child in value.items():
            child_parts = [*parts, str(key)]
            if isinstance(child, (str, int, float, bool)) or child is None:
                key_text = str(key)
                if key_text in EXPLICIT_ID_KEYS or ID_FIELD_RE.search(key_text):
                    rendered = child
                    truncated = isinstance(rendered, str) and len(rendered) > 1000
                    if truncated:
                        rendered = rendered[:1000] + "…"
                    out.append(
                        {
                            "path": path,
                            "pointer": json_pointer(child_parts),
                            "field": key_text,
                            "value": rendered,
                            "value_truncated": truncated,
                            **({"original_value_sha256": sha256_bytes(child.encode("utf-8")),
                                "original_value_length": len(child)} if truncated else {}),
                        }
                    )
            walk_json_fields(child, path, out, child_parts)
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            walk_json_fields(child, path, out, [*parts, str(idx)])


def decode_text(data: bytes) -> tuple[str | None, str | None]:
    if b"\x00" in data[:8192]:
        return None, "binary_nul"
    try:
        return data.decode("utf-8"), None
    except UnicodeDecodeError as exc:
        return None, f"invalid_utf8:{exc.start}"


def tracked_files(repo: Path) -> list[dict[str, str]]:
    raw = run_git(repo, "ls-files", "--stage", "-z", text=False)
    assert isinstance(raw, bytes)
    entries: list[dict[str, str]] = []
    for record in raw.split(b"\x00"):
        if not record:
            continue
        try:
            meta, raw_path = record.split(b"\t", 1)
            mode, blob_sha, stage = meta.decode("ascii").split()
            path = raw_path.decode("utf-8", "surrogateescape")
        except Exception as exc:
            raise InventoryError(f"cannot parse git ls-files entry: {record!r}: {exc}")
        entries.append({"mode": mode, "blob_sha": blob_sha, "stage": stage, "path": path})
    return entries


def scan_repository(repo: Path, max_text_bytes: int) -> dict[str, Any]:
    entries = tracked_files(repo)
    file_records: list[dict[str, Any]] = []
    skipped_text: list[dict[str, Any]] = []
    identifier_index: dict[str, dict[str, Any]] = {}
    structured_fields: list[dict[str, Any]] = []
    bare_stage_refs: list[dict[str, Any]] = []
    canonical_stage_refs: list[dict[str, Any]] = []
    path_flags: list[dict[str, Any]] = []
    typed_surfaces = new_typed_surface_inventory()

    casefold_map: dict[str, list[str]] = defaultdict(list)
    nfc_map: dict[str, list[str]] = defaultdict(list)
    blob_map: dict[str, list[str]] = defaultdict(list)
    content_map: dict[str, list[str]] = defaultdict(list)

    for entry in entries:
        raw_path = entry["path"]
        path = normalize_posix(raw_path)
        casefold_map[path.casefold()].append(path)
        nfc_map[unicodedata.normalize("NFC", path)].append(path)
        blob_map[entry["blob_sha"]].append(path)

        full_path = repo / Path(PurePosixPath(path))
        suffix = full_path.suffix.lower()
        record: dict[str, Any] = {
            "path": path,
            "mode": entry["mode"],
            "stage": entry["stage"],
            "git_blob_sha1": entry["blob_sha"],
            "suffix": suffix,
            "basename": PurePosixPath(path).name,
            "unicode_nfc": unicodedata.normalize("NFC", path) == path,
            "ascii_only": path.isascii(),
        }

        flags: list[str] = []
        basename = record["basename"]
        if COPY_SUFFIX_RE.search(basename):
            flags.append("copy_suffix")
        if VAGUE_NAME_RE.search(basename):
            flags.append("vague_lifecycle_token")
        if DATE_TOKEN_RE.search(basename):
            flags.append("date_token")
        if not record["ascii_only"]:
            flags.append("non_ascii_path")
        if " " in path:
            flags.append("space_in_path")
        if "\\" in raw_path:
            flags.append("backslash_in_path")
        versions = sorted(set(VERSION_RE.findall(basename)))
        if versions:
            record["version_tokens"] = versions
        stages = sorted(
            set(CANONICAL_STAGE_RE.findall(basename))
            | set(BARE_M_STAGE_RE.findall(basename))
            | set(BARE_SLICE_RE.findall(basename))
        )
        if stages:
            record["stage_tokens"] = stages
        if flags:
            record["flags"] = flags
            path_flags.append({"path": path, "flags": flags})

        if entry["mode"] == "160000":
            record["kind"] = "gitlink"
            file_records.append(record)
            continue
        if not full_path.is_file() and not full_path.is_symlink():
            record["read_status"] = "missing_from_checkout"
            collect_typed_surfaces(None, path, typed_surfaces, read_error='MISSING_FROM_CHECKOUT')
            file_records.append(record)
            continue

        data = full_path.read_bytes()
        record["size_bytes"] = len(data)
        record["content_sha256"] = sha256_bytes(data)
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            record["binary_signature"] = "PNG"
        content_map[record["content_sha256"]].append(path)

        should_scan = (suffix in TEXT_EXTENSIONS or path.startswith(MACHINE_PATH_PREFIXES)) and not record.get("binary_signature")
        if should_scan:
            if len(data) > max_text_bytes:
                record["text_scan_status"] = "skipped_size_limit"
                skipped_text.append(
                    {"path": path, "size_bytes": len(data), "limit_bytes": max_text_bytes, "reason": "size_limit"}
                )
                collect_typed_surfaces(None, path, typed_surfaces, read_error='SIZE_LIMIT')
            else:
                text, decode_error = decode_text(data)
                if text is None:
                    record["text_scan_status"] = "skipped_non_utf8"
                    skipped_text.append({"path": path, "size_bytes": len(data), "reason": decode_error})
                    collect_typed_surfaces(None, path, typed_surfaces, read_error=decode_error)
                else:
                    record["text_scan_status"] = "scanned"
                    collect_typed_surfaces(text, path, typed_surfaces)
                    machine_surface = is_machine_surface(path, suffix)
                    for line_no, line in enumerate(text.splitlines(), 1):
                        for token in URN_RE.findall(line):
                            add_index(identifier_index, token, "urn_clued", path, line_no, machine_surface=machine_surface)
                        for token in CLUED_TOKEN_RE.findall(line):
                            add_index(identifier_index, token, "clued_token", path, line_no, machine_surface=machine_surface)
                        for token in UPPER_TYPED_RE.findall(line):
                            add_index(identifier_index, token, "upper_typed_token", path, line_no, machine_surface=machine_surface)
                        for token in VERSION_RE.findall(line):
                            add_index(identifier_index, token, "version_token", path, line_no, machine_surface=machine_surface)
                        for match in CANONICAL_STAGE_RE.finditer(line):
                            canonical_stage_refs.append(
                                {"token": match.group(0), "path": path, "line": line_no, "machine_surface": machine_surface}
                            )
                        for regex, kind in ((BARE_M_STAGE_RE, "bare_m_stage"), (BARE_SLICE_RE, "bare_slice_stage")):
                            for match in regex.finditer(line):
                                bare_stage_refs.append(
                                    {
                                        "token": match.group(0),
                                        "kind": kind,
                                        "path": path,
                                        "line": line_no,
                                        "machine_surface": machine_surface,
                                    }
                                )

                    if suffix == ".json":
                        try:
                            parsed = json.loads(text)
                        except json.JSONDecodeError as exc:
                            record["json_parse_status"] = "invalid"
                            record["json_parse_error"] = {"line": exc.lineno, "column": exc.colno, "message": exc.msg}
                        else:
                            record["json_parse_status"] = "valid"
                            walk_json_fields(parsed, path, structured_fields)
        else:
            record["text_scan_status"] = "not_selected_binary_or_unknown"

        file_records.append(record)

    def collision_sets(mapping: dict[str, list[str]], kind: str) -> list[dict[str, Any]]:
        return [
            {"kind": kind, "key": key, "paths": sorted(paths)}
            for key, paths in sorted(mapping.items())
            if len(set(paths)) > 1
        ]

    duplicate_blobs = [
        {"git_blob_sha1": sha, "paths": sorted(paths)}
        for sha, paths in sorted(blob_map.items())
        if len(set(paths)) > 1
    ]
    duplicate_content = [
        {"content_sha256": sha, "paths": sorted(paths)}
        for sha, paths in sorted(content_map.items())
        if len(set(paths)) > 1
    ]

    for item in identifier_index.values():
        item["types"] = sorted(item["types"])
        item["locations"] = sorted(
            item["locations"], key=lambda loc: (loc["path"], loc["line"], loc.get("pointer", ""))
        )

    machine_bare = [item for item in bare_stage_refs if item["machine_surface"]]
    document_bare = [item for item in bare_stage_refs if not item["machine_surface"]]

    return {
        "tracked_entry_count": len(entries),
        "typed_surface_inventory": finalize_typed_surface_inventory(typed_surfaces),
        "file_count": sum(1 for entry in entries if entry["mode"] != "160000"),
        "gitlink_count": sum(1 for entry in entries if entry["mode"] == "160000"),
        "files": sorted(file_records, key=lambda item: item["path"]),
        "path_flags": sorted(path_flags, key=lambda item: item["path"]),
        "skipped_text_files": sorted(skipped_text, key=lambda item: item["path"]),
        "identifier_index": sorted(identifier_index.values(), key=lambda item: item["token"]),
        "structured_identity_fields": sorted(
            structured_fields, key=lambda item: (item["path"], item["pointer"], item["field"])
        ),
        "stage_references": {
            "canonical": sorted(canonical_stage_refs, key=lambda item: (item["path"], item["line"], item["token"])),
            "bare_machine_surface": sorted(machine_bare, key=lambda item: (item["path"], item["line"], item["token"])),
            "bare_document_surface": sorted(document_bare, key=lambda item: (item["path"], item["line"], item["token"])),
        },
        "collisions": {
            "casefold": collision_sets(casefold_map, "casefold"),
            "unicode_nfc": collision_sets(nfc_map, "unicode_nfc"),
        },
        "duplicate_representations": {
            "same_git_blob_multiple_paths": duplicate_blobs,
            "same_sha256_multiple_paths": duplicate_content,
        },
    }


class GitHubClient:
    def __init__(self, token: str, repository: str):
        self.token = token
        self.repository = repository
        self.base = "https://api.github.com"

    def _request(self, url: str) -> tuple[Any, dict[str, str]]:
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "clued-naming-surface-inventory/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")), dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            raise InventoryError(f"GitHub API {exc.code} for {url}: {body[:1000]}") from exc
        except urllib.error.URLError as exc:
            raise InventoryError(f"GitHub API request failed for {url}: {exc}") from exc

    def get(self, endpoint: str) -> Any:
        url = endpoint if endpoint.startswith("https://") else self.base + endpoint
        value, _ = self._request(url)
        return value

    def paginate(self, endpoint: str, *, item_key: str | None = None) -> list[Any]:
        separator = "&" if "?" in endpoint else "?"
        url = self.base + endpoint + f"{separator}per_page=100"
        out: list[Any] = []
        pages = 0
        while url:
            pages += 1
            if pages > MAX_GITHUB_PAGES:
                raise InventoryError(f"GitHub pagination exceeded {MAX_GITHUB_PAGES} pages: {endpoint}")
            value, headers = self._request(url)
            if item_key is not None:
                items = value.get(item_key)
                if not isinstance(items, list):
                    raise InventoryError(f"GitHub response for {endpoint} lacks list key {item_key}")
            else:
                items = value
                if not isinstance(items, list):
                    raise InventoryError(f"GitHub response for {endpoint} is not a list")
            out.extend(items)
            url = parse_next_link(headers.get("Link") or headers.get("link"))
        return out


def parse_next_link(header: str | None) -> str | None:
    if not header:
        return None
    for part in header.split(","):
        section = part.strip()
        if 'rel="next"' not in section:
            continue
        match = re.match(r"<([^>]+)>", section)
        if match:
            return match.group(1)
    return None


def compact_repository(value: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": value.get("id"),
        "full_name": value.get("full_name"),
        "private": value.get("private"),
        "default_branch": value.get("default_branch"),
        "archived": value.get("archived"),
        "disabled": value.get("disabled"),
        "visibility": value.get("visibility"),
    }


def scan_github(repository: str, token: str) -> dict[str, Any]:
    client = GitHubClient(token, repository)
    quoted_repo = "/".join(urllib.parse.quote(part, safe="") for part in repository.split("/"))
    repo = client.get(f"/repos/{quoted_repo}")
    branches = client.paginate(f"/repos/{quoted_repo}/branches?")
    tags = client.paginate(f"/repos/{quoted_repo}/tags?")
    releases = client.paginate(f"/repos/{quoted_repo}/releases?")
    workflows = client.paginate(f"/repos/{quoted_repo}/actions/workflows?", item_key="workflows")
    artifacts = client.paginate(f"/repos/{quoted_repo}/actions/artifacts?", item_key="artifacts")

    compact_branches = [
        {"name": item.get("name"), "protected": item.get("protected"), "commit_sha": (item.get("commit") or {}).get("sha")}
        for item in branches
    ]
    compact_tags = [
        {
            "name": item.get("name"),
            "commit_sha": (item.get("commit") or {}).get("sha"),
            "tarball_url": item.get("tarball_url"),
            "zipball_url": item.get("zipball_url"),
        }
        for item in tags
    ]
    compact_releases = []
    for release in releases:
        compact_releases.append(
            {
                "id": release.get("id"),
                "tag_name": release.get("tag_name"),
                "name": release.get("name"),
                "target_commitish": release.get("target_commitish"),
                "draft": release.get("draft"),
                "prerelease": release.get("prerelease"),
                "created_at": release.get("created_at"),
                "published_at": release.get("published_at"),
                "assets": [
                    {
                        "id": asset.get("id"),
                        "name": asset.get("name"),
                        "size": asset.get("size"),
                        "digest": asset.get("digest"),
                        "state": asset.get("state"),
                        "created_at": asset.get("created_at"),
                        "updated_at": asset.get("updated_at"),
                    }
                    for asset in release.get("assets") or []
                ],
            }
        )
    compact_workflows = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "path": item.get("path"),
            "state": item.get("state"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }
        for item in workflows
    ]
    compact_artifacts = [
        {
            "id": item.get("id"),
            "name": item.get("name"),
            "size_in_bytes": item.get("size_in_bytes"),
            "digest": item.get("digest"),
            "expired": item.get("expired"),
            "created_at": item.get("created_at"),
            "expires_at": item.get("expires_at"),
            "workflow_run": {
                "id": (item.get("workflow_run") or {}).get("id"),
                "head_branch": (item.get("workflow_run") or {}).get("head_branch"),
                "head_sha": (item.get("workflow_run") or {}).get("head_sha"),
            },
        }
        for item in artifacts
    ]

    return {
        "repository": compact_repository(repo),
        "branches": sorted(compact_branches, key=lambda item: item["name"] or ""),
        "tags": sorted(compact_tags, key=lambda item: item["name"] or ""),
        "releases": sorted(compact_releases, key=lambda item: (item.get("published_at") or "", item.get("id") or 0)),
        "workflows": sorted(compact_workflows, key=lambda item: item["path"] or ""),
        "artifacts": sorted(compact_artifacts, key=lambda item: item.get("id") or 0),
        "counts": {
            "branches": len(compact_branches),
            "tags": len(compact_tags),
            "releases": len(compact_releases),
            "release_assets": sum(len(item["assets"]) for item in compact_releases),
            "workflows": len(compact_workflows),
            "artifacts": len(compact_artifacts),
        },
        "pagination_complete": True,
    }


def classify_findings(repository_inventory: dict[str, Any], github_inventory: dict[str, Any] | None) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    def add(finding_id: str, category: str, title: str, evidence: Any, *, disposition_stage: str, impact: str) -> None:
        findings.append(
            {
                "finding_id": finding_id,
                "classification": "INVENTORY_OBSERVATION_UNDISPOSITIONED",
                "category": category,
                "title": title,
                "impact": impact,
                "disposition_stage": disposition_stage,
                "evidence": evidence,
                "authority_effect": "NONE",
                "engineering_closure": False,
            }
        )

    collisions = repository_inventory["collisions"]
    if collisions["casefold"]:
        add("NSI-OBS-001", "path_collision", "Tracked paths collide under case-folding", collisions["casefold"], disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="CROSS_PLATFORM_PATH_AMBIGUITY")
    if collisions["unicode_nfc"]:
        add("NSI-OBS-002", "path_collision", "Tracked paths collide after Unicode NFC normalization", collisions["unicode_nfc"], disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="UNICODE_NORMALIZATION_AMBIGUITY")

    machine_bare = repository_inventory["stage_references"]["bare_machine_surface"]
    if machine_bare:
        add("NSI-OBS-003", "stage_namespace", "Bare M*/Slice stage references exist on machine surfaces", machine_bare, disposition_stage="PRE_ARCHITECTURE_ACCEPTANCE_NAMING_CLOSURE", impact="CROSS_DOMAIN_STAGE_BINDING_RISK")

    flagged = repository_inventory["path_flags"]
    copy_paths = [item for item in flagged if "copy_suffix" in item["flags"]]
    if copy_paths:
        add("NSI-OBS-004", "copy_identity", "Tracked path names contain copy-number suffixes", copy_paths, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="PHYSICAL_COPY_MAY_BE_MISREAD_AS_REVISION")

    vague_paths = [item for item in flagged if "vague_lifecycle_token" in item["flags"]]
    if vague_paths:
        add("NSI-OBS-005", "lifecycle_token", "Tracked paths contain vague lifecycle tokens", vague_paths, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="FILENAME_MAY_BE_MISREAD_AS_CURRENT_OR_FINAL_AUTHORITY")

    skipped = repository_inventory["skipped_text_files"]
    if skipped:
        add("NSI-OBS-006", "coverage", "Selected text surfaces were not content-scanned", skipped, disposition_stage="INVENTORY_COMPLETION", impact="INCOMPLETE_IDENTIFIER_OCCURRENCE_COVERAGE")

    if github_inventory is not None:
        transformed_assets: list[dict[str, Any]] = []
        for release in github_inventory["releases"]:
            for asset in release["assets"]:
                name = asset.get("name") or ""
                if "._." in name or COPY_SUFFIX_RE.search(name) or VAGUE_NAME_RE.search(name):
                    transformed_assets.append(
                        {
                            "release_id": release.get("id"),
                            "tag_name": release.get("tag_name"),
                            "asset_id": asset.get("id"),
                            "asset_name": name,
                            "digest": asset.get("digest"),
                        }
                    )
        if transformed_assets:
            add("NSI-OBS-007", "transport_name", "Release assets contain transformed or ambiguous transport names", transformed_assets, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="TRANSPORT_NAME_DRIFT_REQUIRES_EXACT_BINDING")

        unprotected = [branch for branch in github_inventory["branches"] if not branch.get("protected")]
        if unprotected:
            add("NSI-OBS-008", "enforcement", "GitHub branches are not marked protected", unprotected, disposition_stage="POST_MIGRATION_ENFORCEMENT", impact="NAMING_CHECK_NOT_YET_UNBYPASSABLE")

    duplicate_sha = repository_inventory["duplicate_representations"]["same_sha256_multiple_paths"]
    if duplicate_sha:
        add("NSI-OBS-009", "representation_copy", "Identical bytes exist at multiple tracked paths", duplicate_sha, disposition_stage="STRUCTURE_FREEZE_PREPARATION", impact="LOGICAL_OBJECT_REPRESENTATION_COPY_CLASSIFICATION_REQUIRED")

    return findings


def load_scope(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise InventoryError(f"cannot read scope contract {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise InventoryError("scope contract must be a JSON object")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(text, encoding="utf-8")
    os.replace(temp, path)


def render_summary(manifest: dict[str, Any], findings: list[dict[str, Any]]) -> str:
    repo = manifest["repository_inventory"]
    github = manifest.get("github_inventory")
    coverage = manifest["coverage"]
    lines = [
        "# Clued Naming Surface Inventory — Structure Freeze Preparation",
        "",
        f"- Schema: `{SUMMARY_SCHEMA}`",
        f"- Generated: `{manifest['generated_at_utc']}`",
        f"- Repository: `{manifest['source_lock']['repository']}`",
        f"- Branch: `{manifest['source_lock']['branch']}`",
        f"- Commit: `{manifest['source_lock']['commit_sha']}`",
        f"- Tree: `{manifest['source_lock']['tree_sha']}`",
        f"- Status: `{manifest['status']}`",
        f"- Authority effect: `{manifest['authority_effect']}`",
        "",
        "## Coverage",
        "",
        "| Surface | Status | Notes |",
        "|---|---|---|",
    ]
    for item in coverage:
        lines.append(f"| `{item['surface']}` | `{item['status']}` | {item.get('notes', '')} |")
    lines.extend(
        [
            "",
            "## Repository inventory",
            "",
            f"- Tracked entries: **{repo['tracked_entry_count']}**",
            f"- Files: **{repo['file_count']}**",
            f"- Gitlinks: **{repo['gitlink_count']}**",
            f"- Structured identity fields: **{len(repo['structured_identity_fields'])}**",
            f"- Indexed identifier tokens: **{len(repo['identifier_index'])}**",
            f"- Bare stage references on machine surfaces: **{len(repo['stage_references']['bare_machine_surface'])}**",
            f"- Case-fold collision sets: **{len(repo['collisions']['casefold'])}**",
            f"- Unicode NFC collision sets: **{len(repo['collisions']['unicode_nfc'])}**",
            f"- Identical-byte multi-path sets: **{len(repo['duplicate_representations']['same_sha256_multiple_paths'])}**",
        ]
    )
    if github is not None:
        counts = github["counts"]
        lines.extend(
            [
                "",
                "## GitHub inventory",
                "",
                f"- Branches: **{counts['branches']}**",
                f"- Tags: **{counts['tags']}**",
                f"- Releases: **{counts['releases']}**",
                f"- Release assets: **{counts['release_assets']}**",
                f"- Workflows: **{counts['workflows']}**",
                f"- Actions artifacts: **{counts['artifacts']}**",
            ]
        )
    lines.extend(
        [
            "",
            "## Inventory observations",
            "",
            "These are undispositioned inventory observations. They are not automatic architecture findings, acceptance decisions, or migration authorizations.",
            "",
            "| ID | Category | Impact | Title |",
            "|---|---|---|---|",
        ]
    )
    for finding in findings:
        lines.append(f"| `{finding['finding_id']}` | `{finding['category']}` | `{finding['impact']}` | {finding['title']} |")
    if not findings:
        lines.append("| — | — | — | No inventory observations emitted |")
    lines.extend(
        [
            "",
            "## Boundaries",
            "",
            "- This output does not rename or migrate any file.",
            "- It does not create a Registry Root Catalog.",
            "- It does not issue Architecture Acceptance or Structure Freeze.",
            "- It does not enable a required check on `main`.",
            "- External surfaces marked pending remain open within this inventory work item.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path("."))
    parser.add_argument("--scope", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--repository", default=os.getenv("GITHUB_REPOSITORY"))
    parser.add_argument("--github-token", default=os.getenv("GITHUB_TOKEN"))
    parser.add_argument("--require-github", action="store_true")
    parser.add_argument("--max-text-bytes", type=int, default=MAX_TEXT_BYTES_DEFAULT)
    args = parser.parse_args()

    repo = args.repo_root.resolve()
    if not (repo / ".git").exists():
        raise InventoryError(f"not a Git worktree: {repo}")

    scope = load_scope(args.scope)
    commit_sha = str(run_git(repo, "rev-parse", "HEAD")).strip()
    tree_sha = str(run_git(repo, "rev-parse", "HEAD^{tree}")).strip()
    branch = str(run_git(repo, "rev-parse", "--abbrev-ref", "HEAD")).strip()
    status_porcelain = str(run_git(repo, "status", "--porcelain=v1"))
    if status_porcelain:
        raise InventoryError("inventory requires a clean worktree")

    repository_inventory = scan_repository(repo, args.max_text_bytes)

    github_inventory: dict[str, Any] | None = None
    github_error: str | None = None
    if args.repository and args.github_token:
        try:
            github_inventory = scan_github(args.repository, args.github_token)
        except Exception as exc:
            github_error = f"{type(exc).__name__}: {exc}"
            if args.require_github:
                raise
    elif args.require_github:
        raise InventoryError("--require-github requires repository and token")

    findings = classify_findings(repository_inventory, github_inventory)
    coverage = [
        {"surface": "repository_tracked_paths", "status": "SCANNED", "notes": "All git-index entries at the exact source commit."},
        {
            "surface": "repository_selected_text_content",
            "status": "SCANNED" if not repository_inventory["skipped_text_files"] else "PARTIAL",
            "notes": "UTF-8 content scan of selected text/machine surfaces; skipped entries are enumerated.",
        },
        {
            "surface": "github_branches_tags_releases_workflows_artifacts",
            "status": "SCANNED" if github_inventory is not None else "PENDING",
            "notes": github_error or "GitHub REST pagination completed.",
        },
        {
            "surface": "chatgpt_library_metadata",
            "status": "PENDING_EXTERNAL_SNAPSHOT",
            "notes": "Must be supplied as a detached metadata-only inventory; no private payload read is implied.",
        },
        {
            "surface": "supabase_identifiers",
            "status": "PENDING_EXTERNAL_SNAPSHOT",
            "notes": "Project/schema/table/function/storage/edge-function/auth surface inventory remains separate.",
        },
        {
            "surface": "cloudflare_and_other_deployment_identifiers",
            "status": "PENDING_EXTERNAL_SNAPSHOT",
            "notes": "Worker/domain/route/deployment/binding identifiers require connector-backed snapshot or formal N/A/retirement proof.",
        },
    ]

    manifest = {
        "schema": SCHEMA,
        "record_id": f"CLUED_NAMING_SURFACE_INVENTORY_{commit_sha[:12].upper()}",
        "generated_at_utc": utc_now(),
        "status": "INVENTORY_CANDIDATE_NOT_CLOSEOUT",
        "authority_effect": "NONE",
        "purpose": "STRUCTURE_FREEZE_PREPARATION_NAMING_SURFACE_INVENTORY",
        "source_lock": {
            "repository": args.repository or scope.get("repository"),
            "branch": branch,
            "commit_sha": commit_sha,
            "tree_sha": tree_sha,
            "scope_path": args.scope.as_posix(),
            "scope_sha256": sha256_file(args.scope),
            "scanner_path": Path(__file__).resolve().relative_to(repo).as_posix(),
            "scanner_sha256": sha256_file(Path(__file__).resolve()),
        },
        "scope_contract": scope,
        "coverage": coverage,
        "repository_inventory": repository_inventory,
        "github_inventory": github_inventory,
        "github_inventory_error": github_error,
        "inventory_observation_ids": [item["finding_id"] for item in findings],
        "aggregate": {
            "tracked_entries": repository_inventory["tracked_entry_count"],
            "repository_files": repository_inventory["file_count"],
            "identifier_tokens": len(repository_inventory["identifier_index"]),
            "structured_identity_fields": len(repository_inventory["structured_identity_fields"]),
            "bare_machine_stage_references": len(repository_inventory["stage_references"]["bare_machine_surface"]),
            "casefold_collision_sets": len(repository_inventory["collisions"]["casefold"]),
            "unicode_nfc_collision_sets": len(repository_inventory["collisions"]["unicode_nfc"]),
            "inventory_observations": len(findings),
            "unresolved_external_surface_count": sum(1 for item in coverage if item["status"].startswith("PENDING")),
        },
        "boundaries": {
            "repository_mutation_by_scanner": False,
            "renaming_or_migration_performed": False,
            "registry_root_catalog_created": False,
            "architecture_acceptance": "NOT_ISSUED",
            "structure_freeze": "NOT_ISSUED",
            "naming_integrity_closeout": "NOT_ISSUED",
            "main_required_check": "NOT_ENABLED_BY_THIS_INVENTORY",
            "private_user_payload_access": "NONE",
        },
        "next_work_within_item": [
            "ATTACH_CHATGPT_LIBRARY_METADATA_SNAPSHOT",
            "ATTACH_SUPABASE_IDENTIFIER_SNAPSHOT_OR_FORMAL_SCOPE_EXCLUSION",
            "ATTACH_CLOUDFLARE_AND_DEPLOYMENT_IDENTIFIER_SNAPSHOT_OR_RETIREMENT_PROOF",
            "DISPOSITION_EACH_INVENTORY_OBSERVATION",
            "REPEAT_SCAN_UNTIL_ALL_IN_SCOPE_SURFACES_ARE_ACCOUNTED_FOR",
        ],
    }

    findings_doc = {
        "schema": FINDINGS_SCHEMA,
        "record_id": f"CLUED_NAMING_SURFACE_INVENTORY_FINDINGS_{commit_sha[:12].upper()}",
        "generated_at_utc": manifest["generated_at_utc"],
        "source_manifest_record_id": manifest["record_id"],
        "source_lock": manifest["source_lock"],
        "status": "UNDISPOSITIONED_INVENTORY_OBSERVATIONS",
        "authority_effect": "NONE",
        "findings": findings,
        "count": len(findings),
        "boundary": "An inventory observation is not automatically a BLOCKER/MAJOR/MINOR. Severity and target disposition require evidence and the applicable governance decision.",
    }

    output = args.output_dir.resolve()
    manifest_path = output / "NamingSurfaceInventoryManifest.json"
    findings_path = output / "NamingSurfaceInventoryFindings.json"
    summary_path = output / "NamingSurfaceInventorySummary.md"
    write_json(manifest_path, manifest)
    write_json(findings_path, findings_doc)
    write_text(summary_path, render_summary(manifest, findings))

    result = {
        "manifest": str(manifest_path),
        "manifest_sha256": sha256_file(manifest_path),
        "findings": str(findings_path),
        "findings_sha256": sha256_file(findings_path),
        "summary": str(summary_path),
        "summary_sha256": sha256_file(summary_path),
        "source_commit": commit_sha,
        "source_tree": tree_sha,
        "status": manifest["status"],
        "inventory_observation_count": len(findings),
        "unresolved_external_surface_count": manifest["aggregate"]["unresolved_external_surface_count"],
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InventoryError as exc:
        print(f"inventory error: {exc}", file=sys.stderr)
        raise SystemExit(1)
