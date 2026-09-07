"""Bounded Step 8 evidence producer; consumes existing candidate formats, issues no authority."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
import sys
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_json(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError('duplicate JSON key: ' + key)
            out[key] = value
        return out
    return json.loads(raw.decode('utf-8-sig') if isinstance(raw, bytes) else raw,
                      object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))


def pointer(value, selection):
    if selection == '':
        return value
    if not isinstance(selection, str) or not selection.startswith('/'):
        raise ValueError('machine reference must use a JSON pointer')
    for part in selection[1:].split('/'):
        if re.search(r'~(?![01])', part):
            raise ValueError('invalid JSON pointer escape')
        part = part.replace('~1', '/').replace('~0', '~')
        if isinstance(value, list):
            if not re.fullmatch(r'0|[1-9][0-9]*', part):
                raise ValueError('invalid array pointer')
            value = value[int(part)]
        else:
            value = value[part]
    return value


def refs(value):
    if isinstance(value, dict):
        if {'source_id', 'pointer'} <= value.keys() and ('source_sha256' in value or 'sha256' in value):
            yield value
        for child in value.values():
            yield from refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from refs(child)


class Validator:
    def __init__(self, bindings, root):
        self.root = root.resolve()
        self.binding_path = bindings.resolve()
        self.bindings_raw = bindings.read_bytes()
        self.bindings = strict_json(self.bindings_raw)
        if self.bindings.get('format') != 'STEP8_SOURCE_LOCATORS_ONLY' or self.bindings.get('authority_effect') != 'NONE':
            raise ValueError('expected source locator selections, not an alternate runtime registry')
        self.errors = []
        self.checks = []
        self.source_observations = {}
        self.reference_observations = []
        self.cache = {}
        self.data = {}
        self.paths = {}
        self.catalog = {}
        for role, selection in self.bindings['inputs'].items():
            path = self.path(selection['path'])
            raw = path.read_bytes()
            self.require(digest(raw) == selection['sha256'], 'SOURCE_DIGEST', role)
            self.paths[role] = path
            self.source_observations[role] = {'path': str(path), 'sha256': digest(raw), 'bytes': len(raw),
                                              'digest_recomputed': True}
            self.data[role] = strict_json(raw) if selection['kind'] == 'json' else raw.decode('utf-8-sig')
        for role in ('step4_sources', 'step5_sources', 'step6_sources'):
            if role not in self.data:
                continue
            for source_id, meta in self.data[role]['sources'].items():
                self.catalog[(source_id, meta['sha256'])] = meta

    def path(self, name):
        path = Path(name)
        path = path if path.is_absolute() else self.root / path
        resolved = path.resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError('source path escapes declared work root: ' + str(name))
        cursor = path
        while cursor != self.root and cursor != cursor.parent:
            if cursor.is_symlink():
                raise ValueError('symlink source rejected')
            cursor = cursor.parent
        return resolved

    def require(self, condition, code, detail):
        if not condition:
            self.errors.append({'code': code, 'detail': detail})
        return condition

    def source(self, reference):
        key = (reference['source_id'], reference.get('source_sha256', reference.get('sha256')))
        if key not in self.catalog:
            raise ValueError('unbound source id/hash: ' + repr(key))
        meta = self.catalog[key]
        if key not in self.cache:
            if meta.get('kind') == 'immutable_source_container':
                # Do not repeat a prior complete 246 MB package audit per negative fixture.
                # This branch makes the inherited provenance explicit; it is not a fresh hash proof.
                path = self.path(meta['path'])
                if path.stat().st_size != meta['bytes']:
                    raise ValueError('retained container size differs')
                self.cache[key] = meta
                self.source_observations['catalog:' + key[0]] = {
                    'path': str(path), 'sha256': meta['sha256'], 'bytes': meta['bytes'],
                    'digest_recomputed': False, 'status': 'INHERITED_PREVIOUSLY_VERIFIED_CONTAINER_DIGEST'}
            else:
                if meta.get('kind') == 'immutable_zip_member':
                    archive = self.path(meta['archive_path'])
                    with zipfile.ZipFile(archive) as zf:
                        raw = zf.read(meta['member'])
                    location = str(archive) + '!' + meta['member']
                else:
                    path = self.path(meta['path'])
                    raw = path.read_bytes()
                    location = str(path)
                if digest(raw) != meta['sha256'] or len(raw) != meta['bytes']:
                    raise ValueError('actual source digest/length differs: ' + key[0])
                try:
                    value = strict_json(raw)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    value = raw.decode('utf-8-sig')
                self.cache[key] = value
                self.source_observations['catalog:' + key[0]] = {
                    'path': location, 'sha256': digest(raw), 'bytes': len(raw), 'digest_recomputed': True}
        value = self.cache[key]
        selection = reference['pointer']
        if selection and not selection.startswith('/'):
            # Existing review files also contain prose citations. Hash-check the source but
            # never pretend the free-text locator is a machine-resolved JSON pointer.
            self.reference_observations.append({'source_id': key[0], 'pointer': selection,
                                                'status': 'DOCUMENTED_PROSE_LOCATOR_NOT_MACHINE_RESOLVED'})
            return value
        result = pointer(value, selection)
        self.reference_observations.append({'source_id': key[0], 'pointer': selection,
                                            'status': 'VERIFIED_SOURCE_HASH_AND_POINTER'})
        return result

    def rule(self, code, action, scope):
        before = len(self.errors)
        try:
            action()
        except (KeyError, IndexError, TypeError, ValueError, OSError, zipfile.BadZipFile) as error:
            self.errors.append({'code': code, 'detail': str(error)})
        self.checks.append({'rule': code, 'status': 'FAIL' if len(self.errors) > before else 'PASS', 'scope': scope})

    def run(self, purpose):
        d = self.data
        candidate_roles = ('ownership', 'namespace_delegation', 'logical', 'aliases', 'copy', 'representation', 'versions')
        self.rule('SOURCE_REFERENCE', lambda: [self.source(ref) for role in candidate_roles for ref in refs(d[role])],
                  'Selected existing source digests and JSON pointers; prose locators explicitly remain documented.')

        def owner():
            self.require(bool(d['ownership']['namespaces']), 'OWNER', 'namespace list empty')
            groups = [r['group_key'] for r in d['ownership']['namespaces']]
            self.require(len(groups) == len(set(groups)), 'OWNER', 'namespace group duplicates')
            for row in d['ownership']['namespaces']:
                ref = row['management_owner']['owner_ref']
                self.require(ref['source_id'] == 'delegation' and ref['pointer'] == '/delegator'
                             and bool(self.source(ref)), 'OWNER', row['group_key'] + ': owner unbound or not delegated owner')
        self.rule('OWNER', owner, 'Administrative namespace ownership only; no business-domain issuer authority inferred.')

        def canonical():
            by_name, by_object = {}, {}
            for row in d['logical']['identity_types']:
                name = (row['namespace'], row['type'])
                ref = row['source_ref']
                identity = (ref['source_id'], ref['source_sha256'], ref['pointer'])
                source_definition = self.source(ref)
                self.require(row['type'] == source_definition['type'] and row['namespace'] == source_definition['namespace'],
                             'CANONICAL_NAME', 'canonical definition name/namespace differs from the owning source row')
                self.require(all(name), 'CANONICAL_COLLISION', 'empty canonical definition name')
                self.require(name not in by_name or by_name[name] == identity, 'CANONICAL_COLLISION', repr(name))
                self.require(identity not in by_object or by_object[identity] == name, 'MULTIPLE_CANONICAL', repr(identity))
                by_name[name], by_object[identity] = identity, name
            self.require(d['logical']['physical_path_is_identity'] is False, 'LOGICAL_IDENTITY', 'path promoted to logical identity')
            self.require(d['logical']['source_history_identity_rewrite_allowed'] is False, 'LOGICAL_IDENTITY', 'historical identity rewrite')
        self.rule('CANONICAL_IDENTITY', canonical, 'Existing source-bound type definitions, not invented runtime object instances.')

        def aliases():
            known = {(r['namespace'], r['type']) for r in d['logical']['identity_types']}
            aliases_seen = set()
            for row in d['aliases']['new_runtime_alias_entries']:
                self.require(set(d['aliases']['required_mapping_fields']) <= row.keys(), 'ALIAS_TARGET', 'required mapping fields missing')
                key = (row['namespace_or_contract'], row['canonical_target'])
                self.require(key in known, 'ALIAS_TARGET', repr(key))
                alias_key = (row['namespace_or_contract'], row['alias'])
                self.require(alias_key not in aliases_seen and alias_key not in known, 'ALIAS_TARGET', 'alias ambiguous/shadows canonical name')
                aliases_seen.add(alias_key)
                self.require(row['read_only_compatibility'] is True and row['new_writes_allowed'] is False,
                             'ALIAS_WRITE', row['alias'])
                self.require(bool(row['lifecycle']) and bool(row['retirement_conditions']) and bool(row['reverse_resolution'])
                             and bool(row['ambiguity_disposition']) and bool(row['source_evidence']), 'ALIAS_TARGET', 'incomplete lifecycle/provenance')
            self.require(d['aliases']['new_write_default'] is False, 'ALIAS_WRITE', 'default permits new writes')
        self.rule('ALIAS_RESOLUTION', aliases, 'Empty real registry is not an exercised alias; populated mappings are tested only in isolated fixtures.')

        def historical():
            policy = d['identity_policy']
            self.require(policy['historical_namespaces_cannot_issue_current_state'] is True, 'CURRENT_HISTORICAL', 'historical namespace can issue current')
            for row in d['current_registry']['artifacts']:
                path = row['path'].replace('\\', '/')
                self.require(not any(part in policy['source_namespaces'] for part in path.split('/')),
                             'CURRENT_HISTORICAL', path)
        self.rule('CURRENT_HISTORICAL', historical, 'Original current artifact registry cannot select sources/archives as current authoritative artifacts.')

        def predecessor():
            entry = d['versions']['direct_predecessor']
            ref = entry['source_ref']
            self.require(ref['source_id'] == 'review-subject' and ref['pointer'] == '/sole_direct_predecessor',
                         'PREDECESSOR', 'direct predecessor must resolve sole architecture predecessor')
            target = self.source(ref)
            self.require(target == d['review_subject']['sole_direct_predecessor'] and target.get('axis') == 'architecture',
                         'PREDECESSOR', 'wrong predecessor subject or axis')
            self.require(entry['cross_axis_predecessor_inference_allowed'] is False, 'PREDECESSOR', 'cross-axis inference enabled')
        self.rule('PREDECESSOR', predecessor, 'Exact source-bound sole architecture predecessor tuple; no transport revision substitution.')

        def version_axis():
            axes = d['versions']['axes']
            self.require(len({r['axis'] for r in axes}) == len(axes), 'VERSION_AXIS', 'duplicate axes')
            expected = {'architecture': d['identity_policy']['current_document_versions']['architecture'],
                        'skill': d['identity_policy']['current_document_versions']['skill_coexistence'],
                        'mapping': d['identity_policy']['current_document_versions']['stable_target_map']}
            for row in axes:
                axis, value = row['axis'], row['observed_or_reserved_identity']
                source = self.source(row['source_ref'])
                if axis in expected:
                    self.require(value == expected[axis], 'VERSION_AXIS', axis)
                elif axis == 'product':
                    self.require(value == source.strip(), 'VERSION_AXIS', axis)
                elif axis == 'candidate_revision':
                    self.require(value in Path(source['path']).name, 'VERSION_AXIS', axis)
                elif axis in ('runtime', 'migration_revision'):
                    self.require(value is None, 'VERSION_AXIS', axis + ': unexecuted/unbound axis given a fabricated value')
        self.rule('VERSION_AXIS', version_axis, 'Existing observed product/design/map/package axes, reserved unexecuted runtime/migration values stay null.')

        def receipt():
            r = d['ci_receipt']
            self.require(r['schema'] == 'clued.phase2-v027-ci-gate-receipt/v1', 'RECEIPT_SUBJECT', 'unsupported receipt type')
            subject = r['candidate']
            meta = self.catalog[('source-zip-container', next(k[1] for k in self.catalog if k[0] == 'source-zip-container'))]
            self.require(subject['sha256'] == meta['sha256'] and subject['bytes'] == meta['bytes']
                         and subject['candidate'] == Path(meta['path']).name, 'RECEIPT_SUBJECT', 'receipt package subject mismatch')
            self.require(bool(re.fullmatch(r'[0-9a-f]{40}', r['commit_sha'])) and str(r['run_id']).isdigit(),
                         'RECEIPT_SUBJECT', 'receipt run/commit identity missing')
        self.rule('RECEIPT_SUBJECT', receipt, 'Recognized historical CI receipt binds its candidate tuple; it is not a fresh runtime/Step 8 PASS receipt.')

        def authorization():
            groups = {r['group_key'] for r in d['ownership']['namespaces']}
            for row in d['namespace_delegation']['delegations']:
                source = self.source({**row['delegator'], 'pointer': ''})
                self.require(row['delegation_source_record_id'] == source['record_id'], 'AUTHORIZATION_SCOPE', 'wrong delegation record')
                for name in ('delegator', 'delegatee'):
                    self.require(row[name]['pointer'] == '/' + name and self.source(row[name]) == source[name],
                                 'AUTHORIZATION_SCOPE', 'actor does not resolve original delegation')
                for name in ('start_condition', 'end_condition', 'revocation', 'approval_requirement'):
                    self.require(row[name] == source[name], 'AUTHORIZATION_SCOPE', name + ': source condition changed')
                self.require(all(ref['group_key'] in groups and ref['file'] == 'NamespaceOwnershipManifest.candidate.json'
                                 for ref in row['namespace_group_refs']), 'AUTHORIZATION_SCOPE', 'namespace scope exceeds declared owner groups')
                self.require(set(source['prohibited_inference']) <= set(row['prohibited_actions']), 'AUTHORIZATION_SCOPE', 'source prohibitions removed')
                self.require(row['effective_authority'].endswith('THIS_DOCUMENT_DOES_NOT_ISSUE_A_NEW_RUNTIME_AUTHORIZATION'),
                             'AUTHORIZATION_SCOPE', 'candidate issues runtime authority')
        self.rule('AUTHORIZATION_SCOPE', authorization, 'Inherited task delegation actor/namespace/lifecycle constraints; not a runtime token authorizer.')

        def consumer():
            rows = d['consumers']['consumers']
            self.require(d['consumers']['consumer_count'] == len(rows), 'CONSUMER_NAMESPACE', 'consumer count differs')
            self.require(len({row['consumer_id'] for row in rows}) == len(rows), 'CONSUMER_NAMESPACE', 'consumer identity duplicated')
            row = next(r for r in rows if r['consumer_id'] == 'C01')
            paths = row['accepted_namespace'].split('；')
            self.require(bool(paths) and all(path.startswith('/') and
                         (json.dumps(path) in d['worker_source'] or "'" + path + "'" in d['worker_source']) for path in paths),
                         'CONSUMER_NAMESPACE', 'C01 advertised namespace absent from exact consumer source')
        self.rule('CONSUMER_NAMESPACE', consumer, 'C01 public HTTP namespace is source-bound; protected runtime namespace/scope bindings remain Step 6 gaps.')

        def copies():
            for name in ('same_digest_automatic_deduplication', 'independent_write_authority', 'new_signature_or_authority_issued'):
                self.require(d['copy'][name] is False, 'COPY_ORIGINAL', name + ': copy promoted to original/authority')
            self.require(bool(d['copy']['copy_occurrence_locator']), 'COPY_ORIGINAL', 'copy occurrence location omitted')
        self.rule('COPY_ORIGINAL', copies, 'Existing copy-identity contract preserves provenance; equal bytes create no independent original/writer.')

        def representations():
            for row in d['representation']['representations']:
                self.require(row['canonical_for_business_state'] is (row['kind'] == 'canonical_machine'),
                             'REPRESENTATION_CANONICAL', row['kind'])
            self.require(d['representation']['reverse_edit_allowed'] is False, 'REPRESENTATION_CANONICAL', 'projection reverse edit')
        self.rule('REPRESENTATION_CANONICAL', representations, 'Read-only mirror, human/compatibility/package/candidate projections cannot issue business Canonical state.')

        projection = {}
        def projections():
            nonlocal projection
            for role, source_id in {'ownership':'namespace', 'versions':'versions', 'aliases':'aliases',
                                    'identity_policy':'identity-policy',
                                    'review_subject':'review-subject'}.items():
                selected = d['projection_bindings']['sources'][source_id]
                self.require(selected['sha256'] == self.source_observations[role]['sha256'] and
                             self.path(selected['path']) == self.paths[role], 'PROJECTION_DRIFT',
                             'projection does not consume the selected Step 8 input: ' + role)
            consumer_selector = d['projection_bindings']['facts']['consumer_bindings']
            consumer_source = d['projection_bindings']['sources'][consumer_selector['source_id']]
            self.require(consumer_selector['pointer'] == '/consumers' and any(
                         consumer_source['sha256'] == self.source_observations[role]['sha256']
                         for role in ('consumers', 'typed_consumers') if role in self.source_observations),
                         'PROJECTION_DRIFT', 'projected consumers must select the exact original or supplemental input')
            command = [self.bindings['node'], str(Path(__file__).with_name('projection-check.mjs')),
                       str(self.paths['projection_generator']), str(self.paths['projection_bindings']),
                       str(self.root), str(self.path(self.bindings['projection_output']))]
            completed = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=45)
            projection = strict_json(completed.stdout)
            self.require(completed.returncode == 0 and not projection.get('mismatches') and
                         not projection.get('upstream_mismatches') and not projection.get('error'),
                         'PROJECTION_DRIFT', projection)
        self.rule('PROJECTION_DRIFT', projections, 'Reuse the Step 7 renderer, exact outputs and upstream source lineage; no second renderer.')

        def status_truth():
            projected = strict_json((self.path(self.bindings['projection_output']) / 'GovernanceManifest.projection.json').read_bytes())
            facts = projected['facts']
            for key in ('step4_candidate_status', 'step5_candidate_status', 'step6_candidate_status', 'step4_decision', 'step5_decision', 'step6_decision'):
                expected = projection.get('expected_facts', {}).get(key)
                self.require(expected is not None and facts[key] == expected, 'PENDING_ACCEPTED', key)
            actual_rows = {row['consumer_id']: row for row in projection.get('expected_facts', {}).get('consumer_bindings', {}).get('value', [])}
            for row in facts['consumer_bindings']['value']:
                original = actual_rows[row['consumer_id']]
                if row.get('evidence_status') in ('PASS', 'EXECUTED_PASS', 'VERIFIED_PASS'):
                    self.require(original.get('evidence_status') == row['evidence_status'] and bool(original.get('positive_and_negative_run_refs')),
                                 'UNEXECUTED_PASS', row['consumer_id'])
                if row.get('gate_requirement', {}).get('runtime_gate_pass_claimed_by_this_binding') is True:
                    self.require(original.get('gate_requirement', {}).get('runtime_gate_pass_claimed_by_this_binding') is True,
                                 'UNEXECUTED_PASS', row['consumer_id'] + ': source-binding inventory became an actual runtime PASS')
            self.require(projected['projection_status'] == 'PREPARATION_ONLY_NOT_STEP7_GATE', 'UNEXECUTED_PASS', 'candidate presented as formal gate')
        self.rule('STATUS_TRUTH', status_truth, 'Projected decisions must equal source facts; existing unexecuted consumers cannot acquire PASS in a derived output.')

        gaps = []
        def typed_bindings():
            roles = ('typed_consumers', 'typed_authorization', 'typed_receipts', 'step6_sources')
            if any(role not in d for role in roles):
                gaps.append({'status':'UNBOUND', 'fields':list(roles),
                             'reason':'Original matrix alone does not bind per-consumer core identities/auth/receipt contracts.'})
                return
            consumers = d['typed_consumers']['consumers']
            matrix_ids = {row['consumer_id'] for row in d['consumers']['consumers']}
            self.require(len(consumers) == len(matrix_ids) and {row['consumer_id'] for row in consumers} == matrix_ids,
                         'CONSUMER_NAMESPACE', 'supplemental registry must cover each existing core consumer exactly once')
            self.require(self.source(d['typed_consumers']['source_matrix_ref']) == d['consumers'],
                         'CONSUMER_NAMESPACE', 'supplemental bindings refer to a different original matrix')
            for role in roles[:3]:
                for ref in refs(d[role]):
                    self.source(ref)
            for role in ('typed_authorization', 'typed_receipts'):
                self.require(d[role]['binding_count'] == len(d[role]['bindings']), 'TYPED_BINDING', role + ': count differs')
            for row in consumers:
                cid = row['consumer_id']
                try:
                    domain = self.source(row['domain_id']['registry_ref'])
                    self.require(row['domain_id']['identifier'] == domain['domain_id'], 'CONSUMER_NAMESPACE', cid + ': unknown domain namespace')
                    self.require(bool(self.source(row['program_id']['source_ref'])) and bool(row['stage_id']['operations'])
                                 and bool(row['stage_id']['definition_refs']), 'TYPED_BINDING', cid + ': program/stage unbound')
                    self.require(bool(self.source(row['owner']['owner_ref'])) and bool(self.source(row['owner']['acceptance_ref'])),
                                 'OWNER', cid + ': owner/acceptance unbound')
                    self.require(bool(row['consumer_identity']) and bool(row['exact_input_contract'])
                                 and bool(row['gate_requirement']['source_refs']), 'TYPED_BINDING', cid + ': input/producer/gate chain incomplete')
                    for ref in row['required_authorization']:
                        self.require(ref['file'] == 'TypedAuthorizationRegistry.candidate.json', 'AUTHORIZATION_SCOPE', cid + ': unauthorized registry')
                        auth = pointer(d['typed_authorization'], ref['pointer'])
                        self.require(auth['consumer_id'] == cid, 'AUTHORIZATION_SCOPE', cid + ': cross-consumer authorization')
                        self.require(auth['grant_issued'] is False and bool(auth['constraints']) and bool(auth['implementation_refs'])
                                     and bool(auth['required_evidence']['predicate']), 'AUTHORIZATION_SCOPE', cid + ': unbound/new grant')
                        if auth['profile'] == 'public':
                            self.require(set(auth['capability']) <= set(row['stage_id']['operations']),
                                         'AUTHORIZATION_SCOPE', cid + ': public authority exceeds qualified operations')
                            bearer_challenged = set(re.findall(
                                r'if\s*\(rpc\.method\s*===\s*"([^"]+)"\s*&&\s*!bearerToken\(request\)\)\s*\{\s*throw new HttpError\(401,',
                                d['worker_source']))
                            if cid == 'C01':
                                self.require('initialize' in bearer_challenged, 'AUTHORIZATION_SCOPE',
                                             'C01 current setup guard no longer matches the understood source pattern; require a scoped review')
                            policies = {p['operation']:p for p in auth.get('operation_policy', [])}
                            for operation in set(auth['capability']) & bearer_challenged:
                                policy = policies.get(operation, {})
                                self.require(policy.get('requires_bearer_presence') is True and
                                             policy.get('missing_bearer_http_status') == 401 and
                                             policy.get('validates_identity_here') is False,
                                             'AUTHORIZATION_SCOPE', cid + ': operation policy contradicts source bearer-presence challenge')
                    ref = row['required_receipt']
                    self.require(ref['file'] == 'TypedReceiptRegistry.candidate.json', 'RECEIPT_SUBJECT', cid + ': unauthorized receipt registry')
                    receipt = pointer(d['typed_receipts'], ref['pointer'])
                    self.require(receipt['consumer_id'] == cid and bool(receipt.get('subject', {}).get('predicate'))
                                 and bool(receipt.get('subject', {}).get('binding_kind')), 'RECEIPT_SUBJECT', cid + ': missing/wrong typed subject')
                    self.require(receipt['scope'] == row['accepted_namespace'], 'CONSUMER_NAMESPACE', cid + ': receipt/consumer namespace differs')
                    self.require(bool(receipt['producer']) and bool(receipt['source_refs']) and bool(receipt['receipt_type']),
                                 'RECEIPT_SUBJECT', cid + ': receipt producer/type source unbound')
                    if cid == 'C01':
                        paths = row['accepted_namespace'].split('；')
                        self.require(all(path.startswith('/') and (json.dumps(path) in d['worker_source'] or
                                     "'"+path+"'" in d['worker_source']) for path in paths), 'CONSUMER_NAMESPACE', cid + ': namespace unsupported by actual source')
                except (KeyError, IndexError, TypeError, ValueError) as error:
                    gaps.append({'consumer_id':cid, 'status':'UNBOUND', 'detail':str(error)})
                    self.require(False, 'TYPED_BINDING', cid + ': ' + str(error))
            # Do not promote the pre-existing C09 declaration/enforcement difference into dual-scope PASS.
            self.require(bool(d.get('export_scope_disposition')), 'TYPED_BINDING', 'C09 existing scoped disposition missing')
        before_bindings = len(self.errors)
        self.rule('TYPED_BINDING', typed_bindings,
                  'Resolve 18 qualified existing consumer identities and their administrative domain/owner, 27 auth and 18 receipt source references. Runtime slots are definitions, not newly executed runs.')
        for error in self.errors[before_bindings:]:
            gaps.append({'status':'UNBOUND_OR_INVALID', 'rule':error['code'], 'detail':error['detail']})
        if purpose == 'freeze':
            self.require(not gaps, 'FREEZE_BINDING', gaps)
        return {'format': 'STEP8_BOUNDED_VALIDATION_RECEIPT', 'run_id': str(uuid.uuid4()),
                'executed_at_utc': datetime.now(timezone.utc).isoformat(), 'purpose': purpose,
                'status': 'FAIL' if self.errors else 'SCOPED_EVIDENCE_PASS',
                'exit_code': 1 if self.errors else 0, 'formal_step8_gate': False, 'freeze_ready': False,
                'authority_effect': 'NONE', 'fixture_only': bool(self.bindings.get('fixture_only')),
                'subject': {'bindings_path': str(self.binding_path), 'sha256': digest(self.bindings_raw)},
                'validator_sha256': digest(Path(__file__).read_bytes()), 'checks': self.checks,
                'errors': self.errors, 'step6_binding_gaps': gaps, 'source_observations': self.source_observations,
                'scoped_step6_bindings_qualified': not gaps,
                'reference_observations': self.reference_observations,
                'projection_summary': {k: v for k, v in projection.items() if k != 'expected_facts'},
                'limits': ['No runtime service tests or production changes executed.',
                           'Inherited complete ZIP digest is not recomputed in this candidate validator.',
                           'Typed design definitions, historical CI receipt, delegated administration and public C01 are bounded positive subjects.',
                           'Per-consumer qualified references supersede old aggregate nulls only for this unchanged-source naming scope.',
                           'No new login is demanded for unchanged consumers; later migration/actual gate/enforcement obligations remain.',
                           'Fixture green cannot satisfy missing Step 6 bindings or issue Step 8 acceptance/Step 11 Freeze.']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bindings', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--purpose', choices=('evidence', 'freeze'), default='evidence')
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    try:
        report = Validator(args.bindings, args.source_root).run(args.purpose)
    except Exception as error:
        report = {'status': 'FAIL', 'exit_code': 1, 'formal_step8_gate': False, 'freeze_ready': False,
                  'errors': [{'code': 'INVALID_INPUT', 'detail': str(error)}]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': report['status'], 'exit_code': report['exit_code'],
                      'formal_step8_gate': False, 'freeze_ready': False,
                      'errors': [row['code'] for row in report['errors']], 'report': str(args.report)}, ensure_ascii=False))
    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
