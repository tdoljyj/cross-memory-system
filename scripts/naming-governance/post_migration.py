"""Check the frozen, actually installed Phase2 file boundary before publication.

This checks local bytes, not GitHub publisher identity or a new authority grant.
The calling trusted workflow/publisher must independently pin the Freeze digest.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
from datetime import datetime, timezone


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def location(root, name):
    root = Path(root).resolve()
    relative = PurePosixPath(name)
    if not name or '\\' in name or ':' in name or relative.is_absolute() or '..' in relative.parts:
        raise ValueError('unsafe relative path')
    path = root.joinpath(*relative.parts)
    cursor = path
    while cursor != root:
        if cursor.is_symlink() or (hasattr(cursor, 'is_junction') and cursor.is_junction()):
            raise ValueError('linked path cannot qualify a frozen installation')
        cursor = cursor.parent
    if not path.resolve().is_relative_to(root):
        raise ValueError('path escapes repository')
    return path


def inspect_installation(repo, freeze_path, expected_freeze):
    root = Path(repo).resolve()
    # Keep caller-selected path components until location() checks each link.
    # Resolving first would erase an in-repository symlink/junction alias.
    freeze_path = Path(freeze_path)
    if not freeze_path.is_absolute():
        freeze_path = Path.cwd() / freeze_path
    if not freeze_path.is_relative_to(root):
        raise ValueError('Freeze must be a bound repository object')
    freeze_path = location(root, freeze_path.relative_to(root).as_posix())
    raw_freeze = freeze_path.read_bytes()
    if digest(raw_freeze) != expected_freeze:
        raise ValueError('Freeze digest drift')
    freeze = json.loads(raw_freeze)
    if freeze.get('type') != 'Phase2StructureFreezeDecision' or freeze.get('state') != 'FROZEN':
        raise ValueError('accepted Freeze required')
    ref = freeze['migration_execution_inputs_ref']
    input_path = location(freeze_path.parent, ref['path'])
    raw_inputs = input_path.read_bytes()
    if digest(raw_inputs) != ref['sha256']:
        raise ValueError('execution inputs drift')
    inputs = json.loads(raw_inputs)
    if inputs.get('format') != 'PHASE2_MIGRATION_EXECUTION_INPUTS_V1':
        raise ValueError('unsupported frozen migration contract')
    errors, observations = [], []
    expected_paths = {}
    for item in inputs['changes']:
        path = location(root, item['path'])
        expected = item['after_sha256']
        actual = digest(path.read_bytes()) if path.is_file() else None
        if path.exists() and not path.is_file():
            errors.append({'code': 'INSTALLED_PATH_TYPE', 'path': item['path']})
        if actual != expected:
            errors.append({'code': 'SEALED_OLD_PATH_REOPENED' if expected is None else 'FROZEN_TARGET_DRIFT',
                           'path': item['path'], 'expected': expected, 'actual': actual})
        observations.append({'path': item['path'], 'expected': expected, 'actual': actual})
        expected_paths[item['path']] = expected
    for item in inputs['immutable_input_locks']:
        path = location(root, item['path'])
        actual = digest(path.read_bytes()) if path.is_file() else None
        if actual != item['sha256']:
            errors.append({'code': 'ACCEPTED_SOURCE_DRIFT', 'path': item['path'],
                           'expected': item['sha256'], 'actual': actual})
    # These three existing TM17-19 namespaces have a frozen initial file set.
    # The sole additional derived activation reference is verified by publication.py.
    for prefix in ['development/contracts/phase2', 'development/projections/phase2', 'development/authority-index/phase2']:
        directory = location(root, prefix)
        if not directory.is_dir():
            errors.append({'code': 'MISSING_GOVERNANCE_NAMESPACE', 'path': prefix})
            continue
        for path in directory.rglob('*'):
            name = path.relative_to(root).as_posix()
            location(root, name)
            if path.is_file() and name not in expected_paths and name != 'development/authority-index/phase2/Activation.json':
                errors.append({'code': 'UNREGISTERED_GOVERNANCE_WRITE', 'path': name})
    return {'type': 'Phase2PostMigrationFileBoundaryEvidence', 'status': 'FAIL' if errors else 'PASS',
            'exit_code': 1 if errors else 0, 'observed_at': datetime.now(timezone.utc).isoformat(),
            'freeze_sha256': expected_freeze, 'execution_inputs_sha256': ref['sha256'],
            'checked_changed_paths': len(inputs['changes']), 'checked_immutable_inputs': len(inputs['immutable_input_locks']),
            'installed_paths': observations, 'errors': errors, 'authority_effect': 'NONE',
            'limits': ['Actual file boundary only; naming semantics use the existing core validator.',
                       'Activation is not accepted by this file check; mandatory read/publish uses publication.py.',
                       'This evidence is not a production runtime test or Step18 non-bypass decision.']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=Path)
    parser.add_argument('--freeze', required=True, type=Path)
    parser.add_argument('--expected-freeze-sha', required=True)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    try:
        report = inspect_installation(args.repo, args.freeze, args.expected_freeze_sha)
    except (ValueError, KeyError, OSError, TypeError) as error:
        report = {'status': 'FAIL', 'exit_code': 1, 'errors': [{'code': 'INVALID_BOUND_INPUT', 'detail': str(error)}]}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')
    print(json.dumps({'status': report['status'], 'exit_code': report['exit_code'], 'errors': report['errors']}))
    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
