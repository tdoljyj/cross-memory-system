"""Prepare existing publication-policy/v1 and an UNSIGNED statement from actual evidence.

Offline only. Does not install, sign, publish, dispatch, commit, or accept Step18.
--base-core-json is a map of each BASE_CORE name to {"run": "Run.json"};
optional run_id/attempt must match that actual local platform snapshot.
Paths in that map are relative to the map file. All four Run objects must have
the exact requested source, original workflow identity and completed/success.
The live publication validator will still independently re-fetch jobs/checks,
app identity, artifacts, permissions and the later real signature.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import fnmatch
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import subprocess
import sys
import zipfile

P = 'docs/execution-plans/phase2-structure-governance/'
CLOUD = 'apps/clued-cloud/'
WORKFLOW = '.github/workflows/phase2-v027-validation.yml'
CORE = 'scripts/naming-governance/publication.py'
EXPECTED_CORE = '74026fd0b6cf859b53d4f925a1147b9a787a92a426f93985f98e4077a2a028b7'
CORE_IDS = {'public-mcp-protocol': 344805139, 'public-mcp-behavior': 344799049,
            'gitleaks': 344805140, 'trivy': 344805141}
STATEMENT_PATH = P + 'step18-publication-20260907/Statement.json'
MEMBERS = {'CIGateReceipt.json', 'GateExecution.json', 'NamingReceipt.json',
           'NamingExecution.json', 'PostMigrationBoundary.json', 'BoundaryControls.json'}
GATES = {'candidate_identity', 'manifest_integrity', 'provenance', 'product_increment_input'}


def need(ok, message):
    if not ok:
        raise ValueError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf8')


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'Duplicate JSON key: ' + key)
            result[key] = value
        return result
    def reject(value):
        raise ValueError('Nonfinite JSON value: ' + value)
    return json.loads(raw.decode('utf-8-sig'), object_pairs_hook=pairs, parse_constant=reject)


def rel(path):
    need(isinstance(path, str) and path and '\\' not in path and ':' not in path and
         not path.startswith('/') and all(x not in ('', '.', '..') for x in path.split('/')),
         'Unsafe repository-relative path: ' + str(path))
    return path


class Source:
    def __init__(self, repo, commit, executable):
        self.repo, self.commit, self.executable, self.cache = repo, commit, executable, {}
        self.git('cat-file', '-e', commit + '^{commit}')

    def git(self, *args):
        return subprocess.check_output([self.executable, '-c', 'safe.directory=' + str(self.repo),
                                        '-C', str(self.repo), *args], stderr=subprocess.PIPE)

    def exists(self, path):
        return bool(self.git('ls-tree', self.commit, '--', rel(path)))

    def raw(self, path):
        rel(path)
        if path not in self.cache:
            self.cache[path] = self.git('cat-file', 'blob', self.commit + ':' + path)
        return self.cache[path]

    def obj(self, path):
        return strict_json(self.raw(path))

    def hashes(self, paths):
        return {path: digest(self.raw(path)) for path in sorted(set(paths))}

    def files(self, prefix):
        return self.git('ls-tree', '-r', '--name-only', self.commit, '--', prefix).decode('utf8').splitlines()


def local_js_dependencies(source, seeds):
    """Follow only literal relative JS/TS imports of these reviewed entry points.

    Non-import runtime/data dependencies are explicit seeds below. This is a
    bounded source-binding helper, not a generic semantic-completeness claim.
    """
    selected, todo = set(), list(seeds)
    patterns = [r'''\b(?:from|import)\s*["'](\.[^"']+)["']''',
                r'''\b(?:import|require)\s*\(\s*["'](\.[^"']+)["']\s*\)''']
    while todo:
        path = todo.pop()
        if path in selected:
            continue
        raw = source.raw(path)
        selected.add(path)
        if PurePosixPath(path).suffix not in {'.js', '.mjs', '.cjs', '.ts', '.tsx'}:
            continue
        text = raw.decode('utf8')
        for pattern in patterns:
            for imported in re.findall(pattern, text):
                target = posixpath.normpath(posixpath.join(posixpath.dirname(path), imported))
                rel(target)
                candidates = [target] if PurePosixPath(target).suffix else [target + ext for ext in
                              ('.ts', '.tsx', '.mjs', '.js', '.json')] + [target + '/index.ts', target + '/index.js']
                matches = [item for item in candidates if source.exists(item)]
                need(len(matches) == 1, 'Resolve the literal dependency explicitly: ' + path + ' -> ' + imported)
                todo.append(matches[0])
    return selected


def load_local(path, evidence):
    raw = path.read_bytes()
    evidence[str(path.resolve())] = digest(raw)
    return strict_json(raw)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--ci-dir', required=True, type=Path)
    parser.add_argument('--base-core-json', required=True, type=Path)
    parser.add_argument('--publisher-actor', required=True)
    parser.add_argument('--publisher-base-ref', required=True)
    parser.add_argument('--sequence', required=True, type=int)
    parser.add_argument('--output-dir', type=Path, help='Default: repository step18-publication-20260907; no installation.')
    parser.add_argument('--git', default=shutil.which('git') or
                        'C:/Users/Windows/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe')
    parser.add_argument('--check-only', action='store_true', help='Validate actual local inputs and policy shape; write nothing.')
    args = parser.parse_args()
    need(re.fullmatch('[0-9a-f]{40}', args.source_commit), 'Exact lowercase source commit SHA required')
    need(args.sequence > 0, 'Explicit positive activation sequence required')
    need(args.publisher_actor and args.publisher_base_ref, 'Explicit real publisher actor and selected base required')
    repo = args.repo.resolve(strict=True)
    source = Source(repo, args.source_commit, args.git)
    evidence = {}
    inspection = load_local(args.ci_dir / 'Inspection.json', evidence)
    run = load_local(args.ci_dir / 'Run.json', evidence)
    jobs = load_local(args.ci_dir / 'Jobs.json', evidence)
    artifact = load_local(args.ci_dir / 'ArtifactMetadata.json', evidence)
    need(inspection['source_commit'] == run['head_sha'] == args.source_commit,
         'Old CI evidence cannot qualify a newer source commit')
    need(run['status'] == 'completed' and run['conclusion'] == 'success', 'Actual successful CI required')
    need(run['path'] == WORKFLOW and run['event'] in ('push', 'workflow_dispatch'), 'Actual normal validation workflow required')
    need(inspection['run_id'] == run['id'] and inspection['attempt'] == run['run_attempt'], 'Inspection/run identity mismatch')
    repository = run['repository']['full_name']
    need(run['head_repository']['full_name'] == repository, 'Foreign source repository rejected')
    need(artifact['id'] == inspection['artifact_id'] and artifact['workflow_run']['id'] == run['id']
         and artifact['workflow_run']['head_sha'] == args.source_commit and artifact['expired'] is False,
         'Artifact identity mismatch or expired artifact')
    native = args.ci_dir / 'NativeEvidence.zip'
    zip_sha = digest(native.read_bytes())
    evidence[str(native.resolve())] = zip_sha
    need(zip_sha == inspection['zip_sha256'] and artifact['digest'] == 'sha256:' + zip_sha
         and native.stat().st_size == artifact['size_in_bytes'], 'Native artifact bytes/digest mismatch')
    receipts = {}
    with zipfile.ZipFile(native) as archive:
        need(len(archive.namelist()) == 6 and set(archive.namelist()) == MEMBERS, 'Exactly the six original CI members required')
        for name in sorted(MEMBERS):
            raw = archive.read(name)
            need(raw == (args.ci_dir / name).read_bytes(), 'Extracted native member bytes differ: ' + name)
            need(inspection['members'][name]['sha256'] == digest(raw), 'Inspection member digest mismatch: ' + name)
            receipts[name] = strict_json(raw)
            evidence[str((args.ci_dir / name).resolve())] = digest(raw)
    gate, naming, execution = (receipts[name] for name in ('CIGateReceipt.json', 'NamingReceipt.json', 'GateExecution.json'))
    need(execution == receipts['NamingExecution.json'], 'Both native execution envelopes must identify the same run')
    for key, value in {'repository': repository, 'source_commit': args.source_commit, 'workflow_sha': args.source_commit,
                       'run_id': str(run['id']), 'run_attempt': str(run['run_attempt']), 'negative_case': 'none'}.items():
        need(execution[key] == value, 'Native execution identity mismatch: ' + key)
    need(gate['overall'] == 'PASS' and set(gate['gates']) == GATES
         and all(row['status'] == 'PASS' for row in gate['gates'].values()), 'All four actual gates must PASS')
    need(gate['commit_sha'] == args.source_commit and gate['run_id'] == str(run['id'])
         and gate['run_attempt'] == str(run['run_attempt']) and gate['repository'] == repository,
         'Native Gate receipt source/run mismatch')
    need(naming['status'] == 'SCOPED_EVIDENCE_PASS' and naming['exit_code'] == 0
         and naming['fixture_only'] is False and naming['errors'] == [], 'Actual Naming PASS required')
    selected = [row for row in jobs['jobs'] if row['name'] == 'Validate Phase2 v0.2.7 candidate']
    need(len(selected) == 1 and selected[0]['status'] == 'completed' and selected[0]['conclusion'] == 'success',
         'A successful permission-mode run cannot replace validate-v027')
    steps = {row['name']: row for row in selected[0]['steps']}
    naming_step = 'Run actual frozen naming boundary'
    gate_step = 'Run real Candidate / Manifest / Provenance / ProductIncrementInput gates'
    for name in (naming_step, gate_step):
        need(steps[name]['status'] == 'completed' and steps[name]['conclusion'] == 'success', 'Actual positive step failed: ' + name)
    need(steps[naming_step]['completed_at'] <= steps[gate_step]['started_at'], 'Actual Naming/four-Gate order violated')

    freeze_path = P + 'Phase2StructureFreezeDecision_20260907.json'
    acceptance_path = P + 'Step17-ScopedAcceptance_20260907.json'
    freeze, acceptance = source.obj(freeze_path), source.obj(acceptance_path)
    need(freeze['state'] == 'FROZEN' and acceptance['state'] == 'ACCEPTED_FOR_ACTUAL_SCOPED_SEMANTIC_NO_CHANGE',
         'Existing Freeze and Step17 acceptance required')
    subject_path = P + freeze['exact_subject']['path']
    subject_sha = digest(source.raw(subject_path))
    need(subject_sha == freeze['subject_sha256'] == acceptance['subject_sha256'], 'Actual accepted subject differs')
    need(acceptance['freeze']['sha256'] == digest(source.raw(freeze_path)), 'Acceptance/Freeze binding mismatch')
    architecture_path = P + freeze['architecture_acceptance_ref']['path']
    need(digest(source.raw(architecture_path)) == freeze['architecture_acceptance_ref']['sha256'] ==
         freeze['architecture_acceptance_digest'], 'Frozen Step10 Architecture acceptance binding mismatch')
    inputs_path = P + 'step12-migration-20260907/ExecutionInputs.candidate.json'
    inputs = source.obj(inputs_path)
    payloads = {row['path']: row['after_sha256'] for row in inputs['changes'] if row['after_sha256'] is not None}
    need(len(inputs['changes']) == 64 and len(payloads) == 45, 'Retain exactly the45 non-deletion frozen payloads')
    for path, expected in payloads.items():
        need(digest(source.raw(path)) == expected, 'Actual qualified-source frozen payload differs: ' + path)
    for row in inputs['changes']:
        if row['after_sha256'] is None:
            need(not source.exists(row['path']), 'Sealed historical entry reopened: ' + row['path'])
    for lock in inputs['immutable_input_locks']:
        need(digest(source.raw(lock['path'])) == lock['sha256'], 'Immutable accepted input differs: ' + lock['path'])
    before = source.obj(P + 'step13-14-actual-verification-20260907/BeforeBoundary.json')
    changed = source.git('diff', '--name-only', before['head'], args.source_commit, '--').decode('utf8').splitlines()
    filters = {'memory-publication-gate': ['memory/**', 'artifacts/clued-two-level-snapshots/**',
               'scripts/verify-memory-publication.mjs', '.github/workflows/memory-publication-gate.yml'],
               'clued-g4-database': ['.github/workflows/clued-g4-database.yml', CLOUD + 'package.json',
               CLOUD + 'package-lock.json', CLOUD + 'supabase/**']}
    applicability = {key: [path for path in changed if any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)]
                     for key, patterns in filters.items()}
    need(not any(applicability.values()), 'A conditional original check applies; bind its actual spec/evidence before generating: ' + str(applicability))

    bindings_path = P + 'step08-validator-20260907/SourceLocators.json'
    bindings = source.obj(bindings_path)
    need(naming['subject']['sha256'] == digest(source.raw(bindings_path)), 'Native Naming binding differs from actual source')
    validator_path = 'scripts/naming-governance/naming_validator.py'
    need(naming['validator_sha256'] == digest(source.raw(validator_path)), 'Native Naming validator differs')
    shared = {'scripts/phase2-v027-validate.py', 'scripts/naming-governance/run.py', validator_path,
              'scripts/naming-governance/post_migration.py', 'scripts/naming-governance/ci_execution.py',
              'scripts/naming-governance/projection-check.mjs', CORE, 'scripts/naming-governance/trusted_launcher.py',
              'tests/test_naming_governance_post_migration.py', 'tests/test_naming_governance_publication.py',
              'tests/test_naming_governance_trusted_launcher.py', bindings_path, inputs_path, architecture_path,
              'artifacts/clued-validation/phase2-v027/candidate-identity.json',
              'artifacts/clued-validation/phase2-v027/candidate-source.json',
              'artifacts/clued-validation/phase2-v027/negative-test-control.json',
              bindings['inputs']['projection_generator']['path'], bindings['inputs']['projection_bindings']['path']}
    package = {key: gate['gates']['candidate_identity']['details'][key] for key in ('sha256', 'bytes', 'members')}
    identity = source.obj('artifacts/clued-validation/phase2-v027/candidate-identity.json')
    need(all(identity[key] == package[key] for key in package), 'Actual candidate package differs from accepted source identity')
    policy = {'contract': 'clued.phase2.publication-policy/v1', 'publication_validator_sha256': digest(source.raw(CORE)),
              'repository': repository, 'source_commit': args.source_commit,
              'subject': {'id': subject_path, 'sha256': subject_sha}, 'candidate_package': package,
              'sequence': args.sequence, 'publisher_actor': args.publisher_actor, 'publisher_base_ref': args.publisher_base_ref,
              'statement_path': STATEMENT_PATH, 'payloads': payloads,
              'acceptance': {'path': acceptance_path, 'sha256': digest(source.raw(acceptance_path)),
                             'assertions': {'/type': acceptance['type'], '/step': 17, '/state': acceptance['state'],
                                            '/new_business_authority': False}, 'subject_pointer': '/subject_sha256'},
              'freeze': {'path': freeze_path, 'sha256': digest(source.raw(freeze_path)),
                         'assertions': {'/type': 'Phase2StructureFreezeDecision', '/state': 'FROZEN'},
                         'subject_pointer': '/subject_sha256'},
              'naming_bindings_sha256': naming['subject']['sha256'], 'naming_validator_sha256': naming['validator_sha256'],
              'workflows': {}, 'additional_required_runs': {}}
    for role, receipt, envelope, step in [('four_gates', 'CIGateReceipt.json', 'GateExecution.json', gate_step),
                                         ('naming', 'NamingReceipt.json', 'NamingExecution.json', naming_step)]:
        policy['workflows'][role] = {'id': run['workflow_id'], 'path': WORKFLOW, 'sha256': digest(source.raw(WORKFLOW)),
                                    'trusted_sources': source.hashes(shared), 'job_name': selected[0]['name'],
                                    'step_name': step, 'receipt_path': receipt, 'execution_path': envelope}
    common_runtime = {CLOUD + path for path in ['package.json', 'package-lock.json', 'evals/public-mcp/wrangler.jsonc',
                                               'evals/public-mcp/worker.ts']}
    for optional in (CLOUD + '.npmrc', CLOUD + 'tsconfig.json'):
        if source.exists(optional):
            common_runtime.add(optional)
    protocol = common_runtime | {CLOUD + 'evals/public-mcp/' + name for name in
               ['protocol-check.mjs', 'verify-tools.mjs', 'verify-flag-matrix.ts', 'tools-list.baseline.json']}
    behavior = common_runtime | {CLOUD + path for path in ['evals/public-mcp/fixtures.mjs',
               'evals/public-mcp/start-isolated.mjs', 'evals/public-mcp/promptfoo/positive.yaml',
               'evals/public-mcp/promptfoo/negative.yaml', 'evals/public-mcp/promptfoo/raw-provider.mjs',
               'tests/p5-real-postgres.test.mjs', 'supabase/config.toml']}
    behavior.update(path for path in source.files(CLOUD + 'supabase/migrations') if path.endswith('.sql'))
    dependencies = {'public-mcp-protocol': local_js_dependencies(source, protocol),
                    'public-mcp-behavior': local_js_dependencies(source, behavior),
                    'gitleaks': {'.github/workflows/gitleaks.yml', '.gitleaksignore'},
                    'trivy': {'.github/workflows/trivy.yml'}}
    for path in ('.gitleaks.toml', '.gitleaks.yaml', '.gitleaks.yml'):
        if source.exists(path):
            dependencies['gitleaks'].add(path)
    for path in ('.trivyignore', '.trivyignore.yaml', 'trivy.yaml'):
        if source.exists(path):
            dependencies['trivy'].add(path)
    core_inputs = load_local(args.base_core_json, evidence)
    need(set(core_inputs) == set(CORE_IDS), 'Exactly the four original BASE_CORE Run snapshot inputs required')
    additional = {}
    for name, workflow_id in CORE_IDS.items():
        item = core_inputs[name]
        run_path = Path(item['run'])
        if not run_path.is_absolute():
            run_path = args.base_core_json.resolve().parent / run_path
        actual = load_local(run_path, evidence)
        path = '.github/workflows/' + name + '.yml'
        for key, expected in {'head_sha': args.source_commit, 'workflow_id': workflow_id, 'path': path,
                              'status': 'completed', 'conclusion': 'success'}.items():
            need(actual[key] == expected, name + ': actual run mismatch ' + key)
        need(actual['repository']['full_name'] == actual['head_repository']['full_name'] == repository,
             name + ': repository mismatch')
        need(actual['event'] in ('push', 'pull_request'), name + ': unreviewed event')
        need(type(actual['id']) is int and actual['id'] > 0 and type(actual['run_attempt']) is int and actual['run_attempt'] > 0,
             name + ': invalid run identity')
        need(item.get('run_id', actual['id']) == actual['id'] and item.get('attempt', actual['run_attempt']) == actual['run_attempt'],
             name + ': requested selector differs from actual Run')
        policy['additional_required_runs'][name] = {'id': workflow_id, 'path': path, 'sha256': digest(source.raw(path)),
            'trusted_sources': source.hashes(dependencies[name]), 'job_names': [name], 'app_id': 15368,
            'app_slug': 'github-actions', 'events': ['push', 'pull_request']}
        additional[name] = {'run_id': actual['id'], 'attempt': actual['run_attempt']}
    need(policy['publication_validator_sha256'] == EXPECTED_CORE, 'Publication implementation changed; review the new core before generating')
    need((repo / CORE).read_bytes() == source.raw(CORE), 'Local load_policy implementation differs from selected source')
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('actual_publication_policy_contract', repo / CORE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    need(len(naming['checks']) == len(module.NAMING_RULES) and
         {row['rule'] for row in naming['checks']} == set(module.NAMING_RULES) and
         all(row['status'] == 'PASS' for row in naming['checks']), 'Native actual Naming rule set incomplete')
    policy_raw = canonical(policy)
    module.load_policy(policy_raw, digest(policy_raw))
    statement = {key: policy[key] for key in ('repository', 'source_commit', 'subject', 'candidate_package', 'payloads', 'sequence')}
    statement.update(contract='clued.phase2.publication-statement/v1', acceptance_sha256=policy['acceptance']['sha256'],
                     freeze_sha256=policy['freeze']['sha256'], evidence={}, additional_required_runs=additional)
    for role, spec in policy['workflows'].items():
        statement['evidence'][role] = {'run_id': run['id'], 'attempt': run['run_attempt'], 'artifact_id': artifact['id'],
            'zip_sha256': zip_sha, 'receipt_sha256': digest((args.ci_dir / spec['receipt_path']).read_bytes()),
            'execution_sha256': digest((args.ci_dir / spec['execution_path']).read_bytes())}
    report = {'type': 'OfflinePublicationPolicyPreparation', 'state': 'LOCAL_EVIDENCE_BOUND_UNSIGNED_STATEMENT_ONLY',
              'source_commit': args.source_commit, 'created_at': datetime.now(timezone.utc).isoformat(),
              'policy_sha256': digest(policy_raw), 'statement_sha256': digest(canonical(statement)),
              'publication_core_sha256': EXPECTED_CORE, 'generator_sha256': digest(Path(__file__).read_bytes()),
              'local_platform_snapshot_sha256': evidence, 'payloads': len(payloads),
              'trusted_source_counts': {key: len(value) for key, value in dependencies.items()},
              'conditional_applicability': {'base': before['head'], 'source': args.source_commit,
                   'changed_path_count': len(changed), 'changed_paths_sha256': digest(canonical(changed)),
                   'matched_paths': applicability, 'result': 'NOT_REQUIRED_FOR_THIS_EXACT_MIGRATION_CHANGESET_ONLY'},
              'signature_created': False, 'installed': False, 'published': False, 'step18_pass': False,
              'authority_effect': 'NONE_NEW',
              'limits': 'Local platform snapshots are checked for consistency, not authenticated offline. Existing live core must re-fetch actual metadata/jobs/checks/App/artifacts, authorized publisher and later real GitHub signature. Policy PIN must be installed independently. No whole-repository dependency completeness claim.'}
    if not args.check_only:
        output = (args.output_dir or repo / P / 'step18-publication-20260907').resolve()
        outputs = {'Policy.json': policy_raw, 'Statement.json': canonical(statement), 'GenerationReport.json': canonical(report)}
        output.mkdir(parents=True, exist_ok=True)
        for name, raw in outputs.items():
            target = output / name
            need(not target.exists() or target.read_bytes() == raw, 'Existing different output: ' + str(target))
        for name, raw in outputs.items():
            target = output / name
            if not target.exists():
                with target.open('xb') as stream:
                    stream.write(raw)
        report['output_directory'] = str(output)
    print(json.dumps({key: report[key] for key in ('state', 'source_commit', 'policy_sha256', 'statement_sha256', 'payloads')}, indent=2))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        print(json.dumps({'state': 'INPUTS_NOT_QUALIFIED_NO_STATEMENT_CREATED', 'error': str(error)}), file=sys.stderr)
        raise SystemExit(1)
