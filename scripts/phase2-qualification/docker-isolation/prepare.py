"""Prepare one fixed Docker probe plan; execution is deliberately unavailable.

This module never starts Docker, invokes a shell, pulls an image or executes a
Skill. Planned argv and expected evidence are review inputs, never actual results.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys

BASE = Path(__file__).resolve().parent
WORK = BASE / 'work'
BOUNDARY = {'qualified': False, 'authorization_effect': 'NONE', 'executed': False}
DOCKER = r'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
PYTHON = '/usr/local/bin/python3'


class Denied(ValueError):
    pass


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def plain(path):
    path = Path(path).absolute()
    for parent in (path, *path.parents):
        if parent.is_symlink() or (hasattr(parent, 'is_junction') and parent.is_junction()):
            raise Denied('Linked path refused')
    return path


def config(value):
    if not isinstance(value, dict) or set(value) != {'image', 'run_key'}:
        raise Denied('Only exact image and run_key fields are accepted')
    image = value['image']
    if not isinstance(image, str) or not re.fullmatch(r'docker\.io/library/python@sha256:[a-f0-9]{64}', image):
        raise Denied('A real fixed Python image digest is required; no tag or implicit pull')
    if not isinstance(value['run_key'], str) or not re.fullmatch(r'[a-f0-9]{32}', value['run_key']):
        raise Denied('Exact 32-hex synthetic run key required')
    return value


def create_argv(image, name, allowed, driver):
    # This produces reviewable data only, with no configurable command, mount,
    # endpoint, env forwarding, privileged mode or resource-limit override.
    for item in (str(allowed), str(driver)):
        if any(c in item for c in ',\n\r'):
            raise Denied('Mount argument contains a delimiter')
    return [DOCKER, 'container', 'create', '--pull=never', '--platform=linux/amd64',
            '--name', name, '--label', 'clued.scope=synthetic-engineering-only',
            '--user=10001:10001', '--read-only', '--network=none', '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true', '--cpus=0.5', '--memory=128m',
            '--memory-swap=128m', '--pids-limit=16', '--restart=no', '--stop-timeout=2',
            '--log-driver=json-file', '--log-opt=max-size=1m', '--log-opt=max-file=1',
            '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
            '--mount', f'type=bind,source={driver},target=/driver/probe.py,readonly',
            '--mount', f'type=bind,source={allowed},target=/allowed',
            '--workdir=/allowed', '--entrypoint=' + PYTHON, image,
            '-I', '-S', '-B', '/driver/probe.py']


def stopped(inspected, expected_id):
    """Expected future Docker observation, not a claim that STOP was executed."""
    if not isinstance(expected_id, str) or not re.fullmatch(r'[a-f0-9]{64}', expected_id):
        raise Denied('Exact container ID required')
    if not isinstance(inspected, dict) or not isinstance(inspected.get('State'), dict):
        return False
    state = inspected.get('State', {})
    finished = state.get('FinishedAt')
    if not isinstance(finished, str) or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})', finished):
        return False
    try:
        timestamp = datetime.fromisoformat(finished.replace('Z', '+00:00'))
    except ValueError:
        return False
    if timestamp.year <= 1 or timestamp.tzinfo is None:
        return False
    return (inspected.get('Id') == expected_id and state.get('Running') is False
            and type(state.get('Pid')) is int and state['Pid'] == 0
            and state.get('Status') == 'exited')


def persist(path, value):
    with Path(path).open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())


def prepare(value):
    value = config(value)
    root = plain(WORK)
    folder = plain(root / value['run_key'])
    driver = plain(BASE / 'probe.py')
    if folder.exists():
        # Even an interrupted/truncated existing Intent must never be overwritten
        # or used to redispatch. Formal reconciliation is not implemented here.
        return {'status': 'UNKNOWN', 'reason': 'Run key already has local evidence; no redispatch', **BOUNDARY}
    root.mkdir(exist_ok=True)
    folder.mkdir()
    allowed = folder / 'allowed'
    allowed.mkdir()
    name = 'clued-synthetic-' + value['run_key']
    result = {'status': 'PREPARED_NOT_EXECUTED', 'image': value['image'],
              'image_locally_verified': False, 'run_key': value['run_key'],
              'probe_sha256': digest(driver), 'preparer_sha256': digest(__file__),
              'allowed_path': str(allowed), 'container_name': name,
              'planned_image_inspect': [DOCKER, 'image', 'inspect', value['image']],
              'planned_create_argv': create_argv(value['image'], name, allowed, driver),
              'startup_order': ['verify actual local image ID/RepoDigest/Linux amd64/Python runtime/declared safe image environment',
                  'verify exact probe/read-only mount and current host authorization; reserve budget/capacity',
                  'persist immutable Intent and read it back before container create',
                  'create exact container with pull=never; persist returned 64-hex container ID before start',
                  'inspect and reject HostConfig/Config/Mounts drift before start',
                  'start only that exact container; read bounded fixed observation and live descendant identity',
                  'persist STOP Intent; stop exact container with timeout 2; wait then inspect exact ID exited/Pid zero',
                  'persist result; on unknown status keep ID, Intent and reservation, never blindly recreate'],
              'required_image_state': 'REAL_IMAGE_DIGEST_AND_LOCAL_IMAGE_NOT_YET_FIXED',
              'remote_intent_sink_satisfied': False, 'formal_ga_satisfied': False,
              'model_and_paid_budget': 0, **BOUNDARY}
    persist(folder / 'intent.json', result)
    if json.loads((folder / 'intent.json').read_text(encoding='utf-8')) != result:
        raise Denied('Local Intent read-back mismatch')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare', 'run', 'formal'])
    parser.add_argument('--config', type=Path)
    args = parser.parse_args()
    try:
        if args.operation != 'prepare':
            raise Denied('Execution unavailable: real image/engine and independently reviewed execution prerequisites are not ready')
        if not args.config:
            raise Denied('Explicit configuration required')
        result = prepare(json.loads(args.config.read_text(encoding='utf-8')))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['status'] == 'PREPARED_NOT_EXECUTED' else 2
    except (Denied, OSError, ValueError) as exc:
        print(json.dumps({'status': 'BLOCKED', 'reason': str(exc), **BOUNDARY}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
