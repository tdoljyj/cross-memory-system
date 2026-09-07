"""Bounded real-repository migration checks. No Canonical writes or network calls."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import subprocess
import sys

HERE = Path(__file__).resolve().parent
GIT = 'C:/Users/Windows/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd/git.exe'
PWSH = 'C:/Users/Windows/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe'
PREFIX = 'docs/execution-plans/phase2-structure-governance/'
PROTECTED = ('memory', 'apps', 'artifacts')
TOOLS = ('canonical_read.py', 'isolated_mirror.py', 'memory.py', 'sync-memory.ps1', 'sync-memory.py', 'verification_context.py')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def file_hash(path):
    if not path.exists():
        return None
    if not path.is_file() or path.is_symlink():
        raise ValueError('Expected regular file: ' + str(path))
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def safe(repo, rel):
    p = repo / rel
    if not p.resolve().is_relative_to(repo.resolve()) or any(x in ('..', '.git') for x in Path(rel).parts):
        raise ValueError('Unsafe path')
    return p


def git(repo, *args):
    return subprocess.check_output([GIT, '-c', 'safe.directory=' + str(repo), '-C', str(repo), *args])


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def input_data(path, expected):
    if file_hash(path) != expected:
        raise ValueError('Execution input hash mismatch')
    data = json.loads(path.read_text(encoding='utf8'))
    if len(data['changes']) != 64 or len(data['immutable_input_locks']) != 39:
        raise ValueError('Unexpected selected migration scope')
    return data


def selected_paths(repo):
    """Tracked protected boundary only; no business contents are decoded or output."""
    paths = git(repo, 'ls-files', '-z', '--', *PROTECTED, '.github/workflows').decode('utf8').split('\0')
    return sorted(p for p in paths if p)


def capture(repo, inputs, input_sha, output):
    errors = []
    for change in inputs['changes']:
        actual = file_hash(safe(repo, change['path']))
        if actual != change['before_sha256']:
            errors.append({'path': change['path'], 'reason': 'NOT_PRE_MIGRATION_STATE'})
    if errors:
        raise ValueError(json.dumps(errors, ensure_ascii=False))
    paths = selected_paths(repo)
    records = [{'path': p, 'sha256': file_hash(safe(repo, p))} for p in paths]
    if any(x['sha256'] is None for x in records):
        raise ValueError('Missing tracked protected input')
    value = {'type': 'MigrationBeforeBoundary', 'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'repository': str(repo), 'head': git(repo, 'rev-parse', 'HEAD').decode().strip(),
             'head_tree': git(repo, 'rev-parse', 'HEAD^{tree}').decode().strip(),
             'execution_inputs_sha256': input_sha, 'file_count': len(records), 'files': records,
             'scope': 'Exact tracked memory/apps/artifacts/workflow bytes; hash only, no business-body interpretation or export.',
             'actual_migration_or_pass_claim': False}
    write_json(output, value)
    return {'status': 'BEFORE_BOUNDARY_CAPTURED_NOT_POST_MIGRATION_PASS', 'files': len(records), 'sha256': file_hash(output)}


def run_cli(argv, repo, label, expected, cwd=None):
    env = os.environ.copy()
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PATH'] = str(Path(sys.executable).parent) + os.pathsep + env.get('PATH', '')
    result = subprocess.run(argv, cwd=cwd or repo.parent, env=env, capture_output=True, timeout=45)
    return {'label': label, 'exit_code': result.returncode, 'expected_exit': expected,
            'passed': result.returncode == expected, 'stdout_sha256': digest(result.stdout),
            'stderr_sha256': digest(result.stderr), 'stdout': result.stdout.decode('utf8', 'replace'),
            'stderr': result.stderr.decode('utf8', 'replace')}


def module_probe(repo):
    # Reuses the original compatibility test's actual assertions against migrated modules.
    code = '''import sys,inspect,importlib.util,json
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root))
import memory,canonical_read,isolated_mirror,verification_context
spec=importlib.util.spec_from_file_location("scoped_sync",root/"sync-memory.py")
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
assert memory.REPO==root and sync.REPO==root and memory.MEMORY==root/"memory"
for module,name in [(memory,"memory.py"),(canonical_read,"canonical_read.py"),(isolated_mirror,"isolated_mirror.py"),(verification_context,"verification_context.py"),(sync,"sync-memory.py")]:
 assert Path(module.__file__)==root/"scripts"/name
memory.validate_bundle=lambda *a,**k:("patched_same_globals",[])
assert sync.validate(root/"unused")==("patched_same_globals",[])
assert Path(inspect.getsourcefile(memory.cmd_retired))==root/"scripts/memory.py"
assert memory.cmd_retired.__globals__ is memory.__dict__ and sync.validate.__globals__ is sync.__dict__
print(json.dumps({"repo_root_correct":True,"implementation_file_visible":True,"monkeypatch_globals_preserved":True}))
'''
    return run_cli([sys.executable, '-c', code, str(repo)], repo, 'actual_root_imports_and_implementation_identity', 0)


def consumer_bindings(repo, inputs, before):
    contract = repo / PREFIX / 'step06-bindings-20260907/TypedConsumerRegistry.candidate.json'
    consumers = json.loads(contract.read_text(encoding='utf8'))['consumers']
    changes = {x['path']: x for x in inputs['changes']}
    result = []
    for consumer in consumers:
        bindings = []
        for entry in consumer['consumer_identity']:
            old = entry['path']
            target = 'scripts/' + old if old in TOOLS else old
            expected = changes[target]['after_sha256'] if target in changes else digest(git(repo, 'show', before['head'] + ':' + old))
            actual = file_hash(safe(repo, target))
            bindings.append({'original_path': old, 'target_path': target, 'symbol': entry.get('symbol'),
                             'expected_sha256': expected, 'actual_sha256': actual, 'passed': expected == actual,
                             'binding_mode': 'MOVED_IMPLEMENTATION_WITH_ROOT_COMPATIBILITY' if target != old else 'UNCHANGED_CURRENT_SOURCE'})
        result.append({'consumer_id': consumer['consumer_id'], 'bindings': bindings,
                       'required_authorization': consumer['required_authorization'], 'required_receipt': consumer['required_receipt'],
                       'scope': 'Preserve existing source-qualified authority/receipt/unknown contract; no new hosted runtime qualification.',
                       'passed': all(x['passed'] for x in bindings)})
    return result


def allowed_tool_delta(repo, before):
    result = []
    marker = '# Physical implementation moved; retain the repository-root module contract.\n'
    path_line = 'sys.path.insert(0, str(Path(__file__).resolve().parent.parent))\n'
    for name in TOOLS:
        original = git(repo, 'show', before['head'] + ':' + name)
        actual = (repo / 'scripts' / name).read_bytes()
        if name in ('memory.py', 'sync-memory.py'):
            old = original.decode('utf8').replace('\r\n', '\n')
            current = actual.decode('utf8').replace('\r\n', '\n')
            current = current.replace(marker + path_line + '\n', '', 1)
            current = current.replace('REPO = Path(__file__).resolve().parent.parent\n', 'REPO = Path(__file__).resolve().parent\n', 1)
            passed = old == current
            rule = 'Only repository-root import anchor insertion and REPO parent-parent correction; all other text identical.'
        elif name == 'sync-memory.ps1':
            old = original.decode('utf8').replace('\r\n', '\n')
            current = actual.decode('utf8').replace('\r\n', '\n')
            current = current.replace('$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)',
                                      '$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path', 1)
            current = current.replace('(Join-Path $repoRoot "scripts/sync-memory.py")', '(Join-Path $repoRoot "sync-memory.py")', 1)
            passed = old == current
            rule = 'Only actual repo-root correction and forwarding to scripts/sync-memory.py; other text identical.'
        else:
            passed = original == actual
            rule = 'Entire implementation byte-identical.'
        result.append({'tool': name, 'passed': passed, 'rule': rule, 'before_sha256': digest(original), 'after_sha256': digest(actual)})
    return result


def verify(repo, inputs, input_sha, before_path, before_sha, phase, output):
    if file_hash(before_path) != before_sha:
        raise ValueError('Before boundary digest mismatch')
    before = json.loads(before_path.read_text(encoding='utf8'))
    if before['repository'] != str(repo) or before['execution_inputs_sha256'] != input_sha:
        raise ValueError('Before boundary identity mismatch')
    errors, checks, runs = [], [], []
    def check(label, passed, detail=None):
        checks.append({'check': label, 'passed': bool(passed), 'detail': detail})
        if not passed:
            errors.append(label)
    changed = [{'path': x['path'], 'expected': x['after_sha256'], 'actual': file_hash(safe(repo, x['path']))} for x in inputs['changes']]
    check('all_64_exact_after_states', all(x['expected'] == x['actual'] for x in changed), changed)
    locks = [{'path': x['path'], 'expected': x['sha256'], 'actual': file_hash(safe(repo, x['path']))} for x in inputs['immutable_input_locks']]
    check('all_39_immutable_contracts', all(x['expected'] == x['actual'] for x in locks), locks)
    protected_drift = [x['path'] for x in before['files'] if file_hash(safe(repo, x['path'])) != x['sha256']]
    check('protected_source_and_workflow_bytes_equal_before', not protected_drift, {'files': len(before['files']), 'drift': protected_drift})
    check('protected_tracked_path_set_equal_before', selected_paths(repo) == [x['path'] for x in before['files']])
    histories = [x for x in inputs['changes'] if x['after_sha256'] is None]
    check('19_old_document_paths_absent', len(histories) == 19 and all(not safe(repo, x['path']).exists() for x in histories))
    for name, list_key, count in [('TypedConsumerRegistry.candidate.json', 'consumers', 18),
                                  ('TypedAuthorizationRegistry.candidate.json', 'bindings', 27),
                                  ('TypedReceiptRegistry.candidate.json', 'bindings', 18)]:
        doc = json.loads((repo / PREFIX / 'step06-bindings-20260907' / name).read_text(encoding='utf8'))
        check(name + '_retained_count', len(doc[list_key]) == count)
    consumers = consumer_bindings(repo, inputs, before)
    check('all_18_source_qualified_consumers_mapped', all(x['passed'] for x in consumers), consumers)
    deltas = allowed_tool_delta(repo, before)
    check('six_implementation_deltas_only_allowlisted_path_corrections', all(x['passed'] for x in deltas), deltas)
    # Never execute a possibly drifted tool or new source before the exact-byte checks hold.
    if errors:
        value = {'phase': phase, 'status': 'BLOCKED_BEFORE_RUNTIME_PROBES', 'errors': errors, 'checks': checks}
        write_json(output, value)
        return value
    if phase in (13, 14):
        cases = [('memory.py', ['--help'], 0), ('memory.py', ['recall', 'generic', '--tier', 'T0'], 0),
                 ('sync-memory.py', ['align-and-verify', 'NONE'], 0), ('sync-memory.py', ['fixture-unknown-mode'], 1)]
        if phase == 14:
            cases += [('memory.py', [action, 'phase2-rejection-probe'], 2) for action in
                      ('add', 'update', 'supersede', 'consolidate', 'procedural', 'rebuild-index', 'migrate', 'delete', 'reject', 'audit')]
            cases.append(('sync-memory.py', ['push'], 2))
        for name, args, expected in cases:
            pair = [run_cli([sys.executable, str(repo / prefix / name), *args], repo,
                            prefix + name + ' ' + ' '.join(args), expected) for prefix in ('', 'scripts/')]
            runs.extend(pair)
            check('same_behavior_' + name + '_' + '_'.join(args), all(x['passed'] for x in pair) and
                  pair[0]['stdout_sha256'] == pair[1]['stdout_sha256'] and pair[0]['stderr_sha256'] == pair[1]['stderr_sha256'])
        probe = module_probe(repo)
        runs.append(probe)
        check(probe['label'], probe['passed'])
        ps_pair = [run_cli([PWSH, '-NoProfile', '-File', str(repo / prefix / 'sync-memory.ps1'), '-Pull', '-Access', 'NONE'],
                           repo, prefix + 'sync-memory.ps1 -Pull -Access NONE', 0) for prefix in ('', 'scripts/')]
        runs.extend(ps_pair)
        check('actual_PS1_root_and_direct_NONE', all(x['passed'] for x in ps_pair) and
              ps_pair[0]['stdout_sha256'] == ps_pair[1]['stdout_sha256'] and ps_pair[0]['stderr_sha256'] == ps_pair[1]['stderr_sha256'])
        check('protected_bytes_unchanged_after_probes', all(file_hash(safe(repo, x['path'])) == x['sha256'] for x in before['files']))
        if phase == 13:
            caller = run_cli([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_p2_verification_context.py'], repo,
                             'actual_existing_P2_caller_packaging_regression', 0, cwd=repo)
            runs.append(caller)
            check(caller['label'], caller['passed'])
    value = {'type': 'ActualScopedPostMigrationVerification', 'phase': phase,
             'status': 'PASS_FOR_SELECTED_CHECKS' if not errors else 'FAILED',
             'repository': str(repo), 'observed_head': git(repo, 'rev-parse', 'HEAD').decode().strip(),
             'before_head': before['head'], 'before_boundary_sha256': before_sha, 'execution_inputs_sha256': input_sha,
             'verifier_sha256': file_hash(Path(__file__)), 'checks': checks, 'runs': runs, 'errors': errors,
             'reused_test_scope': 'Actual compatibility assertions adapted from original nine fixtures; no old fixture suite rerun.',
             'claim_boundary': 'Selected 64 paths / 39 locks and protected exact bytes only; original hosted runtime behavior/production permissions unchanged, not newly qualified. Not Step15/16/18/19 or acceptance.',
             'compatibility_boundary': 'Six shims preserve read-only business access and existing authorized engineering maintenance. CommitRepo is not executed. No new Canonical write path is authorized.',
             'authority_effect': 'NONE', 'new_canonical_writes': 0}
    write_json(output, value)
    return {'phase': phase, 'status': value['status'], 'checks': len(checks), 'runs': len(runs), 'errors': errors, 'sha256': file_hash(output)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['capture', 'verify'])
    for name in ['repo', 'inputs', 'expected-input-sha', 'output']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--before')
    parser.add_argument('--expected-before-sha')
    parser.add_argument('--phase', type=int, choices=[13, 14, 17])
    args = parser.parse_args()
    try:
        repo = Path(args.repo).resolve()
        output = Path(args.output).resolve()
        if output.is_relative_to(repo):
            raise ValueError('Reports must remain outside real repository during checks')
        data = input_data(Path(args.inputs).resolve(), args.expected_input_sha)
        if args.mode == 'capture':
            result = capture(repo, data, args.expected_input_sha, output)
        else:
            if not (args.before and args.expected_before_sha and args.phase):
                raise ValueError('verify requires before identity and phase')
            result = verify(repo, data, args.expected_input_sha, Path(args.before), args.expected_before_sha, args.phase, output)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get('errors') else 0
    except Exception as error:
        print(json.dumps({'status': 'ERROR_NOT_PASS', 'error': str(error)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
