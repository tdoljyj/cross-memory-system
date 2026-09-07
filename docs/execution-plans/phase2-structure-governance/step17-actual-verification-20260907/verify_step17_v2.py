"""Step17 exact migration comparison with two reviewed CI successors. Read-only."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import zipfile

LIBRARY_SHA = '52e9e6aa1fe4a3f1d6e606953abb1ec449c0eb1888f7025fbf3f301a58d6acfc'
BEFORE_SHA = '467890cdee11132fd2b0d96ecc5ba5b3e76ce1ef49143838ab48c31661a1a9f7'
INPUT_SHA = '37a6909deedae17dbfe97e844d8ec596c5de46e73c3cefafd4136008d3f3dcec'
ALLOWED_SHA = '9f79ca2b833f2f91d6b90228d6a6719ba2ddcf479e09a143b12c0f10df4fa54b'
FREEZE_SHA = 'f40c8af253f811f820e4b3eccc144d63ca3548663810aba10bebb22331661b36'
CI_SOURCE = '722d3b20a1cee0c18f7203b4a786565b22e43c6e'
CI_RUN = 34114596702
CI_ARTIFACT = 10015736410
CI_ZIP_SHA = '0ffee607d3e78c4e07f8fecd629fa2e833a18edc28aa7f146f038e5122ec3210'
WORKFLOW = '.github/workflows/phase2-v027-validation.yml'
RECORDER = 'scripts/naming-governance/ci_execution.py'
PREFIX = 'docs/execution-plans/phase2-structure-governance/'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def document(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def main():
    parser = argparse.ArgumentParser()
    for key in ('repo', 'library', 'before', 'inputs', 'allowed', 'ci', 'output'):
        parser.add_argument('--' + key, required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    output = args.output.resolve()
    if output.is_relative_to(repo):
        raise ValueError('Report must stay outside actual repository')
    if digest(args.library.read_bytes()) != LIBRARY_SHA:
        raise ValueError('Original helper verifier digest mismatch')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('original_step13_14_helpers', args.library)
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    if helpers.file_hash(args.before) != BEFORE_SHA or helpers.file_hash(args.allowed) != ALLOWED_SHA:
        raise ValueError('Immutable before boundary or reviewed allowance digest mismatch')
    before = document(args.before)
    allowed = document(args.allowed)
    inputs = helpers.input_data(args.inputs, INPUT_SHA)
    if before['repository'] != str(repo) or before['execution_inputs_sha256'] != INPUT_SHA:
        raise ValueError('Before boundary identity mismatch')
    if (allowed['before_boundary_sha256'], allowed['before_commit'],
        allowed['migration_execution_inputs_sha256'], allowed['freeze_sha256']) != (
            BEFORE_SHA, before['head'], INPUT_SHA, FREEZE_SHA):
        raise ValueError('Allowance has a different source boundary')
    successors = {row['path']: row for row in allowed['files']}
    if len(allowed['files']) != 2 or set(successors) != {WORKFLOW, RECORDER}:
        raise ValueError('Only the two reviewed exact successors are allowed')
    checks, errors = [], []

    def check(name, passed, detail=None):
        checks.append({'check': name, 'passed': bool(passed), 'detail': detail})
        if not passed:
            errors.append(name)

    started = datetime.datetime.now(datetime.timezone.utc)
    head = helpers.git(repo, 'rev-parse', 'HEAD').decode().strip()
    ancestor = subprocess.run([helpers.GIT, '-c', 'safe.directory=' + str(repo), '-C', str(repo),
                               'merge-base', '--is-ancestor', CI_SOURCE, head], capture_output=True)
    check('actual_CI_source_is_ancestor_of_observed_HEAD', ancestor.returncode == 0,
          {'ci_source': CI_SOURCE, 'observed_head': head})
    ci_zip = args.ci / 'NativeEvidence.zip'
    check('exact_native_CI_artifact_zip', helpers.file_hash(ci_zip) == CI_ZIP_SHA)
    required = {'CIGateReceipt.json', 'GateExecution.json', 'NamingReceipt.json',
                'NamingExecution.json', 'PostMigrationBoundary.json', 'BoundaryControls.json'}
    with zipfile.ZipFile(ci_zip) as archive:
        members = archive.namelist()
        exact_members = len(members) == len(required) and set(members) == required
        check('native_CI_members_exact', exact_members)
        if not exact_members:
            raise ValueError('Unexpected native artifact membership')
        member_bindings = [{'path': name, 'sha256': digest(archive.read(name)),
                            'extracted_sha256': helpers.file_hash(args.ci / name)} for name in sorted(required)]
        check('extracted_native_CI_bytes_match_zip', all(x['sha256'] == x['extracted_sha256'] for x in member_bindings), member_bindings)
    run, jobs, metadata = (document(args.ci / name) for name in ('Run.json', 'Jobs.json', 'ArtifactMetadata.json'))
    validation_jobs = [job for job in jobs['jobs'] if job['name'] == 'Validate Phase2 v0.2.7 candidate']
    platform_ok = (run['id'] == CI_RUN and run['head_sha'] == CI_SOURCE and run['run_attempt'] == 1
                   and run['status'] == 'completed' and run['conclusion'] == 'success'
                   and len(validation_jobs) == 1 and validation_jobs[0]['status'] == 'completed'
                   and validation_jobs[0]['conclusion'] == 'success'
                   and metadata['id'] == CI_ARTIFACT and metadata['digest'] == 'sha256:' + CI_ZIP_SHA
                   and metadata['workflow_run']['id'] == CI_RUN and metadata['workflow_run']['head_sha'] == CI_SOURCE)
    check('actual_validation_job_precedes_Step17', platform_ok and
          datetime.datetime.fromisoformat(validation_jobs[0]['completed_at'].replace('Z', '+00:00')) <= started,
          {'run_id': CI_RUN, 'artifact_id': CI_ARTIFACT, 'attempt': 1,
           'job_completed_at': validation_jobs[0]['completed_at'], 'step17_started_at': started.isoformat()})
    executions = [document(args.ci / name) for name in ('GateExecution.json', 'NamingExecution.json')]
    check('native_execution_context_matches_actual_CI', executions[0] == executions[1] and all(
        x['source_commit'] == CI_SOURCE and x['workflow_sha'] == CI_SOURCE and x['run_id'] == str(CI_RUN)
        and x['run_attempt'] == '1' and x['negative_case'] == 'none' for x in executions))
    gate = document(args.ci / 'CIGateReceipt.json')
    naming = document(args.ci / 'NamingReceipt.json')
    boundary = document(args.ci / 'PostMigrationBoundary.json')
    check('native_CI_predecessor_results_present', gate['overall'] == 'PASS' and gate['commit_sha'] == CI_SOURCE
          and gate['run_id'] == str(CI_RUN) and gate['run_attempt'] == '1'
          and set(gate['gates']) == {'candidate_identity', 'manifest_integrity', 'provenance', 'product_increment_input'}
          and all(x['status'] == 'PASS' for x in gate['gates'].values())
          and naming['status'] == 'SCOPED_EVIDENCE_PASS' and not naming['errors']
          and boundary['status'] == 'PASS' and boundary['freeze_sha256'] == FREEZE_SHA
          and boundary['execution_inputs_sha256'] == INPUT_SHA)
    check('actual_Freeze_bytes_unchanged', helpers.file_hash(repo / PREFIX / 'Phase2StructureFreezeDecision_20260907.json') == FREEZE_SHA)
    successor_results = []
    for path, row in successors.items():
        old_entry = helpers.git(repo, 'ls-tree', before['head'], '--', path)
        old_sha = digest(helpers.git(repo, 'show', before['head'] + ':' + path)) if old_entry else None
        committed_sha = digest(helpers.git(repo, 'show', CI_SOURCE + ':' + path))
        actual_sha = helpers.file_hash(helpers.safe(repo, path))
        successor_results.append({'path': path, 'original_sha256': old_sha, 'expected_before_sha256': row['before_sha256'],
                                  'expected_after_sha256': row['after_sha256'], 'ci_source_sha256': committed_sha,
                                  'current_sha256': actual_sha,
                                  'passed': old_sha == row['before_sha256'] and committed_sha == actual_sha == row['after_sha256']})
    check('two_reviewed_successors_exact_before_CI_and_current', all(x['passed'] for x in successor_results), successor_results)
    changed = [{'path': row['path'], 'expected': row['after_sha256'],
                'actual': helpers.file_hash(helpers.safe(repo, row['path']))} for row in inputs['changes']]
    check('all_64_exact_after_states', all(x['expected'] == x['actual'] for x in changed), changed)
    locks = [{'path': row['path'], 'expected': row['sha256'],
              'actual': helpers.file_hash(helpers.safe(repo, row['path']))} for row in inputs['immutable_input_locks']]
    check('all_39_immutable_contracts', all(x['expected'] == x['actual'] for x in locks), locks)
    drift = []
    for row in before['files']:
        path = row['path']
        expected = row['sha256']
        if path == WORKFLOW:
            if expected != successors[path]['before_sha256']:
                raise ValueError('Original protected workflow and reviewed before digest differ')
            expected = successors[path]['after_sha256']
        actual = helpers.file_hash(helpers.safe(repo, path))
        if actual != expected:
            drift.append({'path': path, 'original_sha256': row['sha256'], 'expected_current_sha256': expected, 'actual_sha256': actual})
    check('protected_bytes_with_only_explicit_workflow_successor', not drift,
          {'files': len(before['files']), 'explicit_successor_paths': [WORKFLOW], 'drift': drift})
    check('protected_tracked_path_set_equal_before', helpers.selected_paths(repo) == [row['path'] for row in before['files']])
    check('protected_working_state_equals_actual_CI_source', helpers.git(repo, 'diff', '--name-only', CI_SOURCE, '--',
          *helpers.PROTECTED, '.github/workflows') == b'')
    histories = [row for row in inputs['changes'] if row['after_sha256'] is None]
    check('19_old_document_paths_absent', len(histories) == 19 and all(not helpers.safe(repo, x['path']).exists() for x in histories))
    for name, key, count in [('TypedConsumerRegistry.candidate.json', 'consumers', 18),
                             ('TypedAuthorizationRegistry.candidate.json', 'bindings', 27),
                             ('TypedReceiptRegistry.candidate.json', 'bindings', 18)]:
        check(name + '_retained_count', len(document(repo / PREFIX / 'step06-bindings-20260907' / name)[key]) == count)
    consumers = helpers.consumer_bindings(repo, inputs, before)
    updated = []
    for consumer in consumers:
        for binding in consumer['bindings']:
            if binding['target_path'] == WORKFLOW:
                if consumer['consumer_id'] != 'C15' or binding['expected_sha256'] != successors[WORKFLOW]['before_sha256']:
                    raise ValueError('Only the reviewed original C15 workflow binding may use the successor')
                binding['original_expected_sha256'] = binding['expected_sha256']
                binding['expected_sha256'] = successors[WORKFLOW]['after_sha256']
                binding['passed'] = binding['actual_sha256'] == binding['expected_sha256']
                binding['binding_mode'] = 'EXACT_REVIEWED_CI_SUCCESSOR_WITH_ORIGINAL_CONTRACT_RETAINED'
                binding['allowed_differences_sha256'] = ALLOWED_SHA
                updated.append(consumer['consumer_id'])
        consumer['passed'] = all(x['passed'] for x in consumer['bindings'])
    check('only_C15_uses_reviewed_workflow_successor', updated == ['C15'], updated)
    check('all_18_source_qualified_consumers_mapped', all(x['passed'] for x in consumers), consumers)
    deltas = helpers.allowed_tool_delta(repo, before)
    check('six_implementation_deltas_only_allowlisted_path_corrections', all(x['passed'] for x in deltas), deltas)
    check('original_verifier_before_and_allowance_remain_immutable', helpers.file_hash(args.library) == LIBRARY_SHA
          and helpers.file_hash(args.before) == BEFORE_SHA and helpers.file_hash(args.allowed) == ALLOWED_SHA)
    report = {'type': 'ActualScopedStep17MigrationComparison', 'comparator_version': 2, 'phase': 17,
              'status': 'PASS_FOR_SELECTED_CHECKS' if not errors else 'FAILED',
              'started_at': started.isoformat(), 'completed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'repository': str(repo), 'observed_head': head, 'before_head': before['head'],
              'before_boundary_sha256': BEFORE_SHA, 'execution_inputs_sha256': INPUT_SHA,
              'allowed_differences_sha256': ALLOWED_SHA, 'original_helpers_sha256': LIBRARY_SHA,
              'comparator_sha256': helpers.file_hash(Path(__file__)), 'actual_CI_source': CI_SOURCE,
              'actual_CI_run_id': CI_RUN, 'actual_CI_artifact_id': CI_ARTIFACT, 'actual_CI_zip_sha256': CI_ZIP_SHA,
              'root_adoption_source': 'Parent root execution instruction: actual Step15/16 CI complete; run Step17 using this exact AllowedDifferences scope. Formal acceptance must reference root Step16 decision.',
              'formal_acceptance': False, 'step16_decision_binding': 'REQUIRED_AT_FORMAL_STEP17_ACCEPTANCE',
              'checks': checks, 'errors': errors, 'runtime_tests_rerun': 0, 'new_canonical_writes': 0,
              'claim_boundary': 'Exact migration scope, protected tracked bytes, and typed source/authority/receipt bindings only. Earlier compatibility tests reused by exact unchanged implementations; no new production behavior or Step18/19 qualification.',
              'authority_effect': 'NONE_NEW'}
    helpers.write_json(output, report)
    print(json.dumps({'status': report['status'], 'checks': len(checks), 'errors': errors,
                      'report_sha256': helpers.file_hash(output)}, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'status': 'ERROR_NOT_PASS', 'error': str(error)}))
        raise SystemExit(1)
