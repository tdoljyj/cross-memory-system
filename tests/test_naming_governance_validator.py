"""Real subprocess, retained isolated candidate bytes, target-rule assertions; no mocked verdicts."""
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
CORE = PROJECT / 'scripts/naming-governance'
HERE = None
ROOT = None
BASE = {}
RESULTS = []
CANDIDATE_ZIP = None
SELECTED_TESTS = None


def configure():
    import argparse
    global HERE, ROOT, BASE, CANDIDATE_ZIP, SELECTED_TESTS
    parser = argparse.ArgumentParser(description='Replay the established Step 8 candidate controls in an isolated output directory.')
    parser.add_argument('--bindings', required=True, type=Path)
    parser.add_argument('--source-root', required=True, type=Path)
    parser.add_argument('--output-root', required=True, type=Path)
    parser.add_argument('--node', help='Optional Node executable override; defaults to the input locator value.')
    parser.add_argument('--candidate-zip', type=Path, help='Explicit external original package when using portable source views.')
    parser.add_argument('--test-method', action='append', help='Run only a named existing test method; may be repeated.')
    args = parser.parse_args()
    ROOT = args.source_root.resolve()
    HERE = args.output_root.resolve()
    if HERE == ROOT or not HERE.is_relative_to(ROOT):
        parser.error('--output-root must be an isolated child of --source-root')
    HERE.mkdir(parents=True, exist_ok=True)
    BASE = json.loads(args.bindings.read_text(encoding='utf-8-sig'))
    if args.node:
        BASE['node'] = args.node
    CANDIDATE_ZIP = args.candidate_zip.resolve() if args.candidate_zip else None
    SELECTED_TESTS = args.test_method
    if SELECTED_TESTS and any(not name.startswith('test_') or not hasattr(ValidatorIntegrationTests,name) for name in SELECTED_TESTS):
        parser.error('--test-method must select an existing test method')
    write(HERE/'InputBindings.candidate.json', BASE)



def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture(name, mutate=None, projection_mutate=None, populated_alias=False):
    folder = HERE / 'fixtures' / name
    folder.mkdir(parents=True, exist_ok=True)
    binding = copy.deepcopy(BASE)
    binding['fixture_only'] = True
    data = {}
    # Each case has independent bytes; never edit any actual Step 4/5/6/7 input.
    for role, selected in binding['inputs'].items():
        source = ROOT / selected['path']
        if selected['kind'] == 'json':
            path = folder / (role + '.json')
            shutil.copyfile(source, path)
            data[role] = json.loads(path.read_text(encoding='utf-8-sig'))
            selected['path'] = str(path.relative_to(ROOT))
    original_data = copy.deepcopy(data)
    if populated_alias:
        target = data['logical']['identity_types'][0]
        data['aliases']['new_runtime_alias_entries'] = [{
            'alias': 'fixture_read_only_artifact_revision',
            'namespace_or_contract': target['namespace'], 'canonical_target': target['type'],
            'read_only_compatibility': True, 'new_writes_allowed': False,
            'lifecycle': 'ISOLATED_VALIDATOR_FIXTURE_ONLY', 'retirement_conditions': 'Never installed; discard after test.',
            'reverse_resolution': target['type'], 'ambiguity_disposition': 'reject',
            'source_evidence': target['source_ref']}]
    if mutate:
        mutate(data)
    # Follow the selected source identities, including a supplemental typed consumer selector.
    # No current source-ID spelling is treated as an instruction to revert to the old matrix.
    for role in ('ownership','versions','aliases','consumers','typed_consumers','typed_authorization',
                 'typed_receipts','identity_policy','review_subject'):
        selected = binding['inputs'][role]
        path = ROOT / selected['path']
        if data[role] != original_data[role]:
            write(path, data[role])
        for source in data['projection_bindings']['sources'].values():
            if source['sha256'] == BASE['inputs'][role]['sha256']:
                source.update(path=selected['path'], sha256=sha(path))
    if populated_alias:
        # A new isolated alias is a pending candidate, never an accepted modification.
        # Keep all unrelated accepted lineage checks; do not forge an updated acceptance decision.
        projection = data['projection_bindings']
        projection['facts']['step5_decision'] = None
        alias_ids = {sid for sid, source in projection['sources'].items()
                     if source['path'] == binding['inputs']['aliases']['path']}
        projection['lineage_checks'] = [row for row in projection['lineage_checks']
            if not (row['target_source_id'] in alias_ids and row['expected_digest']['source_id']=='step5-acceptance')]
    for role, value in data.items():
        path = ROOT / binding['inputs'][role]['path']
        if value != original_data[role]:
            write(path, value)
        binding['inputs'][role]['sha256'] = sha(path)
    output = folder / 'generated'
    rendered = subprocess.run([binding['node'], str(CORE/'render-fixture.mjs'),
                               str(ROOT/binding['inputs']['projection_generator']['path']),
                               str(ROOT/binding['inputs']['projection_bindings']['path']), str(ROOT), str(output), str(HERE/'fixtures')],
                              capture_output=True, text=True, encoding='utf-8')
    if rendered.returncode:
        raise AssertionError('fixture rendering failed: ' + rendered.stderr)
    if projection_mutate:
        projection_mutate(output)
    binding['projection_output'] = str(output.relative_to(ROOT))
    write(folder/'InputBindings.json', binding)
    return folder


def invoke(folder, expected, target=None, purpose='evidence', binding=None):
    binding = binding or folder/'InputBindings.json'
    command = [sys.executable, str(CORE/('run.py' if CANDIDATE_ZIP else 'naming_validator.py')), '--bindings', str(binding),
               '--source-root', str(ROOT), '--purpose', purpose, '--report', str(folder/'Receipt.json')]
    if CANDIDATE_ZIP:
        command += ['--candidate-zip', str(CANDIDATE_ZIP)]
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', timeout=60)
    (folder/'stdout.txt').write_text(result.stdout, encoding='utf-8')
    (folder/'stderr.txt').write_text(result.stderr, encoding='utf-8')
    report = json.loads((folder/'Receipt.json').read_text(encoding='utf-8'))
    codes = [row['code'] for row in report['errors']]
    entry = {'case': folder.name, 'purpose': purpose, 'process_exit_code': result.returncode,
             'expected_exit_code': expected, 'target_rule': target, 'observed_error_codes': codes,
             'target_rule_failed': target in codes if target else None,
             'receipt': str((folder/'Receipt.json').relative_to(HERE)), 'receipt_sha256': sha(folder/'Receipt.json'),
             'fixture_bindings_sha256': sha(binding), 'command': command,
             'passed': result.returncode == expected and (target is None or target in codes)}
    RESULTS.append(entry)
    assert result.returncode == expected, entry
    if target:
        assert target in codes, entry
        assert 'INVALID_INPUT' not in codes, 'target error was only malformed test setup'
    return report


class ValidatorIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not BASE:
            raise unittest.SkipTest('Supply explicit --bindings, --source-root and --output-root to replay candidate evidence.')

    def test_positive_13_types(self):
        report = invoke(fixture('positive_13_types', populated_alias=True), 0)
        self.assertFalse(report['freeze_ready'])
        self.assertFalse(report['formal_step8_gate'])
        self.assertTrue(report['fixture_only'])
        coverage = {'canonical_name':'CANONICAL_IDENTITY', 'namespace_ownership':'OWNER',
                    'alias_resolution':'ALIAS_RESOLUTION', 'logical_object_identity':'CANONICAL_IDENTITY',
                    'representation':'REPRESENTATION_CANONICAL', 'copy_identity':'COPY_ORIGINAL',
                    'version_axis':'VERSION_AXIS', 'typed_receipts':'RECEIPT_SUBJECT',
                    'typed_authorization':'AUTHORIZATION_SCOPE', 'typed_consumers':'CONSUMER_NAMESPACE',
                    'deterministic_projections':'PROJECTION_DRIFT', 'direct_predecessor':'PREDECESSOR',
                    'current_historical_distinction':'CURRENT_HISTORICAL'}
        checks = {row['rule']: row for row in report['checks']}
        for category, rule in coverage.items():
            self.assertEqual(checks[rule]['status'], 'PASS', category)
        write(HERE/'PositiveTypeCoverage.json', {'status':'13_BOUNDED_POSITIVE_TYPES_EXECUTED',
              'fixture_only': True, 'formal_step8_gate': False,
              'types': [{'baseline_type': category, 'rule': rule, 'scope': checks[rule]['scope']} for category, rule in coverage.items()]})

    def test_negative_16(self):
        def bad_owner(d):
            del d['ownership']['namespaces'][0]['management_owner']
        def collision(d):
            row = copy.deepcopy(d['logical']['identity_types'][0])
            row['source_ref'] = copy.deepcopy(d['logical']['identity_types'][1]['source_ref'])
            d['logical']['identity_types'].append(row)
        def multiple(d):
            row = copy.deepcopy(d['logical']['identity_types'][0])
            row['type'] += '_second_canonical'
            d['logical']['identity_types'].append(row)
        def historical(d):
            d['current_registry']['artifacts'][0]['path'] = 'archives/forbidden_current.json'
        def axis(d):
            next(r for r in d['versions']['axes'] if r['axis']=='architecture')['observed_or_reserved_identity'] = 'v0.2.7.1'
        def auth(d):
            d['namespace_delegation']['delegations'][0]['namespace_group_refs'].append(
                {'file':'NamespaceOwnershipManifest.candidate.json', 'group_key':'UNAUTHORIZED_NAMESPACE'})
        def representation(d):
            next(r for r in d['representation']['representations'] if r['kind']=='human_projection')['canonical_for_business_state'] = True
        def readme(output):
            path = output/'README.governance.md'
            path.write_text(path.read_text(encoding='utf-8')+'\nOwner: fixture_intruder\n', encoding='utf-8')
        def projected(output, edit):
            path = output/'GovernanceManifest.projection.json'
            value = json.loads(path.read_text(encoding='utf-8'))
            edit(value)
            write(path, value)
        cases = [
            ('N01_missing_namespace_owner', 'OWNER', bad_owner, None, False),
            ('N02_same_name_different_objects', 'CANONICAL_COLLISION', collision, None, False),
            ('N03_one_object_multiple_canonical', 'MULTIPLE_CANONICAL', multiple, None, False),
            ('N04_alias_missing_target', 'ALIAS_TARGET', lambda d:d['aliases']['new_runtime_alias_entries'][0].update(canonical_target='DOES_NOT_EXIST'), None, True),
            ('N05_alias_new_write', 'ALIAS_WRITE', lambda d:d['aliases']['new_runtime_alias_entries'][0].update(new_writes_allowed=True), None, True),
            ('N06_current_uses_historical', 'CURRENT_HISTORICAL', historical, None, False),
            ('N07_wrong_direct_predecessor', 'PREDECESSOR', lambda d:d['versions']['direct_predecessor']['source_ref'].update(pointer='/subject'), None, False),
            ('N08_mixed_version_axis', 'VERSION_AXIS', axis, None, False),
            ('N09_receipt_missing_subject', 'RECEIPT_SUBJECT', lambda d:d['typed_receipts']['bindings'][0].pop('subject'), None, False),
            ('N10_authorization_scope_escalation', 'AUTHORIZATION_SCOPE', auth, None, False),
            ('N11_consumer_unauthorized_namespace', 'CONSUMER_NAMESPACE', lambda d:d['typed_consumers']['consumers'][0].update(accepted_namespace='/unauthorized/namespace'), None, False),
            ('N12_readme_registry_disagreement', 'PROJECTION_DRIFT', None, readme, False),
            ('N13_copy_claims_original', 'COPY_ORIGINAL', lambda d:d['copy'].update(independent_write_authority=True), None, False),
            ('N14_representation_claims_canonical', 'REPRESENTATION_CANONICAL', representation, None, False),
            ('N15_pending_projected_accepted', 'PENDING_ACCEPTED', None, lambda o:projected(o,lambda v:v['facts']['step5_candidate_status'].update(value='ACCEPTED')), False),
            ('N16_unexecuted_projected_pass', 'UNEXECUTED_PASS', None, lambda o:projected(o,lambda v:v['facts']['consumer_bindings']['value'][0].update(evidence_status='PASS')), False),
        ]
        for name, rule, mutate, projection_mutate, alias in cases:
            with self.subTest(name=name):
                invoke(fixture(name, mutate, projection_mutate, alias), 1, rule)

    def test_input_digest_rejection(self):
        folder = fixture('extra_source_digest_drift')
        path = folder/'copy.json'
        path.write_bytes(path.read_bytes()+b' ')
        invoke(folder, 1, 'SOURCE_DIGEST')

    def test_actual_per_consumer_bindings_qualify(self):
        folder = HERE/'fixtures/real_candidate_binding_qualification'
        folder.mkdir(parents=True, exist_ok=True)
        report = invoke(folder, 0, None, 'freeze', HERE/'InputBindings.candidate.json')
        self.assertFalse(report['fixture_only'])
        self.assertFalse(report['step6_binding_gaps'])
        self.assertFalse(report['freeze_ready'])

    def test_missing_core_identity_rejects_freeze_prerequisites(self):
        folder = fixture('extra_missing_core_identity', lambda d:d['typed_consumers']['consumers'][0].pop('domain_id'))
        report = invoke(folder, 1, 'FREEZE_BINDING', 'freeze')
        self.assertTrue(report['step6_binding_gaps'])

    def test_typed_public_auth_cannot_bypass_actual_initialize_challenge(self):
        def mutate(d):
            row = next(r for r in d['typed_authorization']['bindings'] if r['consumer_id']=='C01' and r['profile']=='public')
            next(p for p in row['operation_policy'] if p['operation']=='initialize')['requires_bearer_presence'] = False
        invoke(fixture('extra_public_initialize_escalation', mutate), 1, 'AUTHORIZATION_SCOPE')

    def test_typed_auth_cross_consumer_rejected(self):
        def mutate(d):
            row = d['typed_consumers']['consumers'][0]
            row['required_authorization'] = copy.deepcopy(d['typed_consumers']['consumers'][1]['required_authorization'])
        invoke(fixture('extra_cross_consumer_authorization', mutate), 1, 'AUTHORIZATION_SCOPE')

    def test_historical_ci_receipt_missing_subject_rejected(self):
        invoke(fixture('extra_historical_ci_missing_subject', lambda d:d['ci_receipt'].pop('candidate')), 1, 'RECEIPT_SUBJECT')


if __name__ == '__main__':
    configure()
    suite = (unittest.TestSuite(ValidatorIntegrationTests(name) for name in SELECTED_TESTS) if SELECTED_TESTS
             else unittest.defaultTestLoader.loadTestsFromTestCase(ValidatorIntegrationTests))
    outcome = unittest.TextTestRunner(verbosity=2).run(suite)
    write(HERE/'TestResults.json', {'status':'PASS' if outcome.wasSuccessful() else 'FAIL',
          'subprocess_cases':len(RESULTS), 'cases_passed':sum(row['passed'] for row in RESULTS),
          'negative_baseline_cases':16, 'positive_baseline_types':13, 'formal_step8_gate':False,
          'selected_test_methods':SELECTED_TESTS, 'all_baseline_cases_executed_in_this_invocation':SELECTED_TESTS is None,
          'fixture_green_is_not_real_freeze':True, 'cases':RESULTS})
    sys.exit(0 if outcome.wasSuccessful() else 1)
