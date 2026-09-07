"""Prepared, NOT EXECUTED: reversible controls against the actual installed launcher.

No repository source changes, bootstrap, activation, or Step18 acceptance. Default
mode only prints the plan. Root may run --execute after independently installing
the real trust store. Do not interrupt while a mutation is active; finally restores
ordinary failures, but no Python program can promise cleanup after host termination.
"""
import sys
if not sys.flags.isolated:
    raise SystemExit('Run this control runner with the fixed Python executable and -I.')

import argparse
from contextlib import contextmanager, ExitStack
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid
from datetime import datetime, timezone

ROOT = Path('C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/phase2-governance-check')
PYTHON = Path('C:/Users/Windows/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe')
HERE = Path('C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/step18-live-controls')
TRUST = ROOT / '.git/clued-phase2'
LAUNCHER = TRUST / 'trusted_launcher.py'
LAUNCHER_SHA = '32d0d3e2fda441e589d33a0b63042482cf4c33630bb0eb63e69d2d7bd0e6d35a'
POST_SHA = 'bbe3dfe6d6949357ae32643e8cad7493b27d487638e7750c6b5b279c181d882e'
FREEZE_SHA = 'f40c8af253f811f820e4b3eccc144d63ca3548663810aba10bebb22331661b36'
INPUTS_SHA = '37a6909deedae17dbfe97e844d8ec596c5de46e73c3cefafd4136008d3f3dcec'
TARGETS = ('GovernanceRegistry.projection.json', 'GovernanceManifest.projection.json')
KNOWN_ERRORS = {
    'trusted launcher requires Python -I',
    'publish requires exact expected-current SHA or NONE',
    'local post-migration guard rejected before publication',
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=True, indent=2) + '\n', encoding='utf-8')


def checked_path(path):
    require(path.is_absolute() and '..' not in path.parts, 'Unsafe control path')
    for part in (path, *path.parents):
        require(not part.is_symlink() and not part.is_junction(), 'Linked control path refused')
    return path


def bound_bytes(path, expected):
    raw = checked_path(path).read_bytes()
    require(sha(raw) == expected, 'Bound input digest mismatch: ' + path.name)
    return raw


def relative_path(base, name):
    require(isinstance(name, str) and name and ':' not in name and '\\' not in name and
            not name.startswith('/') and all(p not in ('', '.', '..') for p in name.split('/')),
            'Unsafe bound reference')
    return checked_path(base.joinpath(*name.split('/')))


def preflight():
    require(os.name == 'nt', 'Live controls require the actual Windows host')
    require(Path(sys.executable).resolve() == PYTHON.resolve(), 'Wrong control runtime')
    bound_bytes(LAUNCHER, LAUNCHER_SHA)
    bound_bytes(TRUST / 'post_migration.py', POST_SHA)
    raw = checked_path(TRUST / 'trust-config.json').read_bytes()
    config = json.loads(raw)
    require(config['contract'] == 'clued.phase2.local-trust-config/v1', 'Wrong trust contract')
    pins = config['pins']
    require(Path(pins['repository_root']).resolve() == ROOT.resolve(), 'Wrong installed root')
    require(pins['launcher_sha256'] == LAUNCHER_SHA and pins['post_migration_sha256'] == POST_SHA,
            'Reviewed control-flow implementation differs')
    require(Path(pins['python']['path']).resolve() == PYTHON.resolve(), 'Wrong installed runtime')
    bound_bytes(PYTHON, pins['python']['sha256'])
    bound_bytes(Path(pins['gh']['path']), pins['gh']['sha256'])
    bound_bytes(TRUST / 'publication.py', pins['publication_sha256'])
    policy = json.loads(bound_bytes(TRUST / 'policy.json', pins['policy_sha256']))
    require(policy['publication_validator_sha256'] == pins['publication_sha256'], 'Policy core mismatch')
    bootstrap = json.loads(bound_bytes(TRUST / 'Bootstrap.json', config['bootstrap_sha256']))
    require(bootstrap.get('fixture_only') is not True and bootstrap['state'] == 'AUTHORIZED' and
            bootstrap['scope'] == 'TM19_GOVERNANCE_READ_PUBLISH', 'Real delegated installation required')
    freeze_path = relative_path(ROOT, pins['freeze']['path'])
    require(pins['freeze']['sha256'] == FREEZE_SHA, 'Freeze is outside this reviewed control set')
    freeze = json.loads(bound_bytes(freeze_path, FREEZE_SHA))
    require(freeze['type'] == 'Phase2StructureFreezeDecision' and freeze['state'] == 'FROZEN', 'Freeze not accepted')
    ref = freeze['migration_execution_inputs_ref']
    require(ref['sha256'] == INPUTS_SHA, 'Frozen execution contract differs')
    inputs_path = relative_path(freeze_path.parent, ref['path'])
    inputs = json.loads(bound_bytes(inputs_path, INPUTS_SHA))
    require(len(inputs['changes']) == 64 and len(inputs['immutable_input_locks']) == 39 and
            sum(row['after_sha256'] is not None for row in inputs['changes']) == 45, 'Frozen denominator differs')
    selected = {}
    for name in TARGETS:
        relative = 'development/projections/phase2/' + name
        matches = [row for row in inputs['changes'] if row['path'] == relative]
        require(len(matches) == 1, 'Projection is not uniquely frozen')
        row = matches[0]
        payload = bound_bytes(relative_path(inputs_path.parent, row['payload']['path']), row['payload']['sha256'])
        require(row['after_sha256'] == sha(payload) and len(payload) == row['payload']['bytes'], 'Payload binding differs')
        bound_bytes(relative_path(ROOT, relative), row['after_sha256'])
        selected[name] = row
    return config, freeze_path, selected, {
        'launcher_sha256': LAUNCHER_SHA, 'post_migration_sha256': POST_SHA,
        'freeze_sha256': FREEZE_SHA, 'execution_inputs_sha256': INPUTS_SHA,
        'trust_config_sha256': sha(raw), 'bootstrap_sha256': config['bootstrap_sha256'],
        'publication_sha256': pins['publication_sha256'], 'policy_sha256': pins['policy_sha256'],
        'python_sha256': pins['python']['sha256'], 'changed_paths': 64, 'payloads': 45, 'immutable_inputs': 39,
    }


def safe_guard(guard):
    require(isinstance(guard, dict), 'Missing structured local guard')
    # Preserve actual error objects and digest metadata, not business payloads.
    result = {key: guard[key] for key in ('type', 'status', 'exit_code', 'freeze_sha256',
              'execution_inputs_sha256', 'checked_changed_paths', 'checked_immutable_inputs', 'authority_effect') if key in guard}
    result['errors'] = [{key: item[key] for key in ('code', 'path', 'expected', 'actual') if key in item}
                        for item in guard.get('errors', [])]
    return result


def process(arguments):
    completed = subprocess.run(arguments, cwd=HERE, capture_output=True, timeout=180)
    report = {'exit_code': completed.returncode,
              'stdout_sha256': sha(completed.stdout), 'stderr_sha256': sha(completed.stderr),
              'stdout_bytes': len(completed.stdout), 'stderr_bytes': len(completed.stderr)}
    parsed = None
    for channel in (completed.stdout, completed.stderr):
        try:
            value = json.loads(channel)
            if isinstance(value, dict):
                parsed = value
                break
        except (ValueError, UnicodeError):
            pass
    if parsed is not None:
        if 'error' not in parsed:
            report['structured_response'] = {key: parsed[key] for key in ('type', 'status', 'exit_code') if key in parsed}
            return report, parsed, completed.stderr
        report['structured_error'] = {key: parsed[key] for key in ('type', 'status', 'step15_pass', 'step18_pass') if key in parsed}
        error = parsed.get('error', '')
        report['structured_error']['error'] = error if error in KNOWN_ERRORS else '[unrecognized error; digest retained]'
        report['structured_error']['error_sha256'] = sha(str(error).encode('utf-8'))
        if isinstance(parsed.get('evidence'), dict) and isinstance(parsed['evidence'].get('local_post_migration_guard'), dict):
            report['structured_error']['local_post_migration_guard'] = safe_guard(parsed['evidence']['local_post_migration_guard'])
    return report, parsed, completed.stderr


def launcher_args(*args, isolated=True):
    return [str(PYTHON), *(['-I'] if isolated else []), '-B', '-X', 'utf8', str(LAUNCHER), *args]


def guard_baseline(freeze_path, output):
    evidence_path = output / ('baseline-' + uuid.uuid4().hex + '.json')
    result, _, _ = process([str(PYTHON), '-I', '-B', '-X', 'utf8', str(TRUST / 'post_migration.py'),
                           '--repo', str(ROOT), '--freeze', str(freeze_path), '--expected-freeze-sha', FREEZE_SHA,
                           '--report', str(evidence_path)])
    guard = safe_guard(json.loads(evidence_path.read_bytes()))
    # The checker writes only paths/digests/diagnostics. Retain reduced schema.
    dump(evidence_path, guard)
    require(result['exit_code'] == 0 and guard['status'] == 'PASS' and not guard['errors'] and
            guard['checked_changed_paths'] == 64 and guard['checked_immutable_inputs'] == 39,
            'Preexisting or final local boundary drift; controls stopped')
    return {'process': result, 'guard': guard, 'evidence_file': evidence_path.name}


@contextmanager
def win_handle(path, *, create=False, directory=False):
    """Keep exact file/parent objects stable; permit the real guard to read them."""
    checked_path(path)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                  wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    access = 0x80000000 if directory else (0x80000000 | 0x40000000 | (0x10000 if create else 0))
    share = 3 if directory else 1  # No delete sharing; files also disallow other writers.
    flags = 0x00200000 | (0x02000000 if directory else 0)  # OPEN_REPARSE_POINT / BACKUP_SEMANTICS.
    handle = kernel.CreateFileW(str(path), access, share, None, 1 if create else 3, flags, None)
    require(handle != ctypes.c_void_p(-1).value, 'Cannot exclusively own live control object')
    file = None
    try:
        if directory:
            yield handle
        else:
            import msvcrt
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
            file = os.fdopen(descriptor, 'r+b', buffering=0)
            yield (handle, file)
    finally:
        if file is not None:
            file.close()  # Owns and closes the original handle.
        else:
            kernel.CloseHandle(handle)


@contextmanager
def stable_parents(path):
    with ExitStack() as stack:
        for directory in reversed([p for p in path.parents if p == ROOT or p.is_relative_to(ROOT)]):
            stack.enter_context(win_handle(directory, directory=True))
        checked_path(path)
        yield


def write_handle(file, raw):
    file.seek(0)
    remaining = memoryview(raw)
    while remaining:
        written = file.write(remaining)
        require(written is not None and written > 0, 'Live control write could not complete')
        remaining = remaining[written:]
    file.truncate()
    file.flush()
    os.fsync(file.fileno())


def verify_guard_rejection(result, parsed, code, relative):
    require(result['exit_code'] == 1 and parsed is not None and parsed.get('status') == 'FAIL' and
            parsed.get('error') == 'local post-migration guard rejected before publication', 'Wrong live rejection stage')
    require('core' not in parsed and 'core' not in (parsed.get('evidence') or {}), 'Unexpected core evidence')
    guard = parsed['evidence']['local_post_migration_guard']
    require(guard['status'] == 'FAIL' and guard['exit_code'] == 1 and guard['freeze_sha256'] == FREEZE_SHA and
            len(guard['errors']) == 1 and guard['errors'][0]['code'] == code and
            guard['errors'][0]['path'] == relative, 'Injected change did not uniquely explain rejection')
    result['api_reachability'] = {'reached': False, 'basis': 'Exact reviewed launcher digest + actual pre-core guard rejection branch; no packet/process telemetry claim.',
                                  'launcher_sha256': LAUNCHER_SHA}


def projection_case(row, record):
    path = relative_path(ROOT, row['path'])
    record.update({'id': 'append-lf-' + path.name, 'path': row['path'], 'expected_error': 'FROZEN_TARGET_DRIFT'})
    with stable_parents(path), win_handle(path) as (_, file):
        original = file.read()
        require(sha(original) == row['after_sha256'] == row['payload']['sha256'], 'Read-before-mutation payload mismatch')
        record['original_sha256'] = sha(original)
        try:
            write_handle(file, original + b'\n')
            record['injected_sha256'] = sha(original + b'\n')
            record['process'], parsed, _ = process(launcher_args('read'))
            verify_guard_rejection(record['process'], parsed, 'FROZEN_TARGET_DRIFT', row['path'])
            record['result'] = 'PASS'
        finally:
            write_handle(file, original)
            file.seek(0)
            record['restored_sha256'] = sha(file.read())
            record['restored_path_sha256'] = sha(checked_path(path).read_bytes())
            record['restored'] = record['restored_sha256'] == record['restored_path_sha256'] == row['after_sha256']
            require(record['restored'], 'Critical: projection restoration failed')


def namespace_case(record):
    relative = 'development/contracts/phase2/.step18-live-control-' + uuid.uuid4().hex + '.json'
    path = relative_path(ROOT, relative)
    owned = b'{"type":"NON_AUTHORITATIVE_LIVE_NEGATIVE_CONTROL"}\n'
    record.update({'id': 'exclusive-extra-namespace-file', 'path': relative,
                   'expected_error': 'UNREGISTERED_GOVERNANCE_WRITE', 'owned_bytes_sha256': sha(owned)})
    with stable_parents(path):
        with win_handle(path, create=True) as (handle, file):
            try:
                write_handle(file, owned)
                record['process'], parsed, _ = process(launcher_args('read'))
                verify_guard_rejection(record['process'], parsed, 'UNREGISTERED_GOVERNANCE_WRITE', relative)
                record['result'] = 'PASS'
            finally:
                # Delete the precise CREATE_NEW object by its still-owned handle,
                # never a path found after releasing ownership or a preexisting file.
                file.seek(0)
                record['cleanup_object_sha256'] = sha(file.read())
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.SetFileInformationByHandle.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
                kernel.SetFileInformationByHandle.restype = wintypes.BOOL
                delete = ctypes.c_ubyte(1)  # FILE_DISPOSITION_INFO.DeleteFile is BOOLEAN.
                require(kernel.SetFileInformationByHandle(handle, 4, ctypes.byref(delete), ctypes.sizeof(delete)),
                        'Critical: owned control deletion failed')
        record['restored_absence'] = not path.exists()
        require(record['restored_absence'], 'Critical: owned namespace file remains')


def quick_cases(records):
    cases = (
        ('no-python-isolation', launcher_args('read', isolated=False), 1, 'trusted launcher requires Python -I'),
        ('caller-policy-override', launcher_args('read', '--policy', 'C:/not-a-trusted-policy.json'), 2, 'ARGPARSE_REJECTED_POLICY_OVERRIDE'),
        ('publish-missing-cas', launcher_args('publish', '--attestation-commit', '0' * 40, '--publication-pr', '1'), 1,
         'publish requires exact expected-current SHA or NONE'),
    )
    for name, arguments, expected_exit, expected_error in cases:
        record = {'id': name, 'expected_exit': expected_exit, 'expected_error': expected_error}
        records.append(record)
        result, parsed, stderr = process(arguments)
        record['process'] = result
        require(result['exit_code'] == expected_exit, 'Wrong quick rejection exit')
        if name == 'caller-policy-override':
            require(b'unrecognized arguments: --policy' in stderr, 'Policy override was not rejected by argument parser')
            result['structured_error'] = {'origin': 'actual argparse stderr', 'code': expected_error,
                                           'message': 'unrecognized arguments: --policy C:/not-a-trusted-policy.json',
                                           'raw_stderr_sha256': sha(stderr)}
        else:
            require(parsed is not None and parsed.get('status') == 'FAIL' and parsed.get('error') == expected_error,
                    'Wrong quick rejection reason')
        record['result'] = 'PASS'
        result['api_reachability'] = {'reached': False, 'basis': 'Exact reviewed launcher digest; actual isolation/parser/selector rejection before core.',
                                      'launcher_sha256': LAUNCHER_SHA}
        if name == 'publish-missing-cas':
            record['unused_selectors'] = 'Zero SHA and PR 1 are syntax-only negative-test inputs; never resolved, no run or attestation claim.'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='Root explicitly runs the prepared actual reversible controls after installation.')
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps({'status': 'PREPARED_NOT_EXECUTED', 'controls': 6, 'step18_pass': False,
                          'activation_forgery': 'Not enabled; no activation modification in this runner.'}))
        return 0
    checked_path(HERE)
    output = HERE / 'runs' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8])
    output.mkdir(parents=True, exist_ok=False)
    report = {'type': 'Phase2ActualTrustedEntryNegativeControls', 'status': 'RUNNING', 'fixture_only': False,
              'started_at': datetime.now(timezone.utc).isoformat(), 'runner_sha256': sha(Path(__file__).read_bytes()),
              'step18_pass': False, 'authority_effect': 'NONE', 'cases': [],
              'limits': ['Limited local trusted entry rejection evidence; not Git-main protection or Step18 acceptance.',
                         'No activation mutation. No business payloads or credentials retained in the evidence.',
                         'No-API findings use exact reviewed control flow, not independent network telemetry.']}
    try:
        config, freeze, rows, binding = preflight()
        report['binding'] = binding
        report['baseline_before'] = guard_baseline(freeze, output)
        quick_cases(report['cases'])
        for name in TARGETS:
            preflight()  # Installation and frozen payloads must still match before each write.
            record = {}
            report['cases'].append(record)
            try:
                projection_case(rows[name], record)
            finally:
                dump(output / 'Report.json', report)
        preflight()
        record = {}
        report['cases'].append(record)
        try:
            namespace_case(record)
        finally:
            dump(output / 'Report.json', report)
        report['baseline_after'] = guard_baseline(freeze, output)
        report['status'] = 'PASS' if len(report['cases']) == 6 and all(row.get('result') == 'PASS' for row in report['cases']) else 'FAIL'
    except BaseException as error:
        report['status'] = 'FAIL'
        report['failure'] = {'type': type(error).__name__, 'message_sha256': sha(str(error).encode('utf-8'))}
        # Known runner RuntimeError messages contain only filenames/control facts.
        if isinstance(error, RuntimeError):
            report['failure']['message'] = str(error)
    finally:
        report['finished_at'] = datetime.now(timezone.utc).isoformat()
        dump(output / 'Report.json', report)
    print(json.dumps({'status': report['status'], 'completed_controls': sum(row.get('result') == 'PASS' for row in report['cases']),
                      'report': str(output / 'Report.json'), 'step18_pass': False}))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
