"""Fixed Linux Docker wiring model. No command execution or authorization issuer.

The state machine consumes synthetic observations only. Generated argv is review
data; neither it nor local Intent may authorize Docker, CI or a formal action.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re

BASE = Path(__file__).resolve().parent
PROBE = BASE.parent / 'docker-isolation' / 'probe.py'
PROBE_SHA256 = '2168145b42166b4de1ea470b4fd232549d661542761ffe279955d0ace5580523'
DOCKER = '/usr/bin/docker'
LINUX_ROOT = '/tmp/clued-linux-docker-candidate'
BOUNDARY = {'mode': 'ENGINEERING_MODEL_ONLY', 'executed': False,
            'qualified': False, 'authorization_effect': 'NONE'}
PHASES = {'INTENT_RECORDED', 'CREATE_SENT', 'CREATED', 'INSPECTED', 'START_SENT',
          'RUNNING', 'STOP_INTENT', 'STOP_SENT', 'WAIT_SENT', 'STOPPED', 'UNKNOWN'}


class Denied(ValueError):
    pass


def exact(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def config(value):
    if type(value) is not dict or set(value) != {'image', 'run_key'}:
        raise Denied('Only image and run_key are accepted')
    if not exact(value['image'], r'docker\.io/library/python@sha256:[a-f0-9]{64}'):
        raise Denied('Exact Python image digest required; its existence is not established')
    if not exact(value['run_key'], r'[a-f0-9]{32}'):
        raise Denied('Exact synthetic run key required')
    return dict(value)


def paths(value):
    value = config(value)
    root = LINUX_ROOT + '/' + value['run_key']
    return root + '/probe.py', root + '/allowed'


def create_argv(value):
    value = config(value)
    driver, allowed = paths(value)
    return [DOCKER, 'container', 'create', '--pull=never', '--platform=linux/amd64',
            '--name=clued-synthetic-' + value['run_key'],
            '--label=clued.scope=synthetic-engineering-only',
            '--user=10001:10001', '--read-only', '--network=none', '--cap-drop=ALL',
            '--security-opt=no-new-privileges:true', '--cpus=0.5', '--memory=128m',
            '--memory-swap=128m', '--pids-limit=16', '--restart=no', '--stop-timeout=2',
            '--ipc=private', '--no-healthcheck', '--log-driver=json-file', '--log-opt=max-size=1m',
            '--log-opt=max-file=1', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
            '--mount', f'type=bind,source={driver},target=/driver/probe.py,readonly',
            '--mount', f'type=bind,source={allowed},target=/allowed',
            '--workdir=/allowed', '--entrypoint=/usr/local/bin/python3', value['image'],
            '-I', '-S', '-B', '/driver/probe.py']


def container_id(value):
    if not exact(value, r'[a-f0-9]{64}'):
        raise Denied('Only a full exact container ID is accepted')
    return value


def fixed_argv(operation, identity):
    identity = container_id(identity)
    commands = {
        'inspect': [DOCKER, 'container', 'inspect', identity],
        'start': [DOCKER, 'container', 'start', identity],
        'stop': [DOCKER, 'container', 'stop', '--time=2', identity],
        'wait': [DOCKER, 'container', 'wait', identity],
    }
    if operation not in commands:
        raise Denied('Operation is outside the fixed allowlist')
    return commands[operation]


def stopped(value, identity):
    identity = container_id(identity)
    if type(value) is not dict or value.get('Id') != identity or type(value.get('State')) is not dict:
        return False
    s = value['State']
    if s.get('Running') is not False or type(s.get('Pid')) is not int or s['Pid'] != 0 or s.get('Status') != 'exited':
        return False
    finished = s.get('FinishedAt')
    if not exact(finished, r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})'):
        return False
    try:
        date = datetime.fromisoformat(finished.replace('Z', '+00:00'))
    except ValueError:
        return False
    return date.year > 1 and date.tzinfo is not None


def prestart(value, identity, inspected):
    """Conservative inspect model; NOT proof of image provenance or OS isolation.

Image environment must be empty in this initial candidate. A real Python image
with inherited environment is rejected until an exact accepted successor binds
its environment. No arbitrary caller-supplied environment allowlist is accepted.
"""
    value = config(value)
    if type(inspected) is not dict or inspected.get('Id') != container_id(identity):
        return False
    h, c, s = (inspected.get(k) for k in ('HostConfig', 'Config', 'State'))
    if any(type(item) is not dict for item in (h, c, s)):
        return False
    if s.get('Status') != 'created' or s.get('Running') is not False or type(s.get('Pid')) is not int or s['Pid'] != 0:
        return False
    required = {'ReadonlyRootfs': True, 'Privileged': False, 'NetworkMode': 'none',
                'CapDrop': ['ALL'], 'CapAdd': None, 'SecurityOpt': ['no-new-privileges:true'],
                'NanoCpus': 500000000, 'Memory': 134217728, 'MemorySwap': 134217728,
                'PidsLimit': 16, 'IpcMode': 'private', 'PidMode': '', 'Binds': None,
                'Devices': [], 'DeviceRequests': None, 'VolumesFrom': None,
                'PortBindings': {}, 'PublishAllPorts': False,
                'RestartPolicy': {'Name': 'no', 'MaximumRetryCount': 0},
                'Tmpfs': {'/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777'},
                'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '1m', 'max-file': '1'}}}
    for key, expected in required.items():
        if key not in h or type(h[key]) is not type(expected) or h[key] != expected:
            return False
    if not (c.get('Image') == value['image'] and c.get('User') == '10001:10001'
            and c.get('Entrypoint') == ['/usr/local/bin/python3']
            and c.get('Cmd') == ['-I', '-S', '-B', '/driver/probe.py']
            and c.get('WorkingDir') == '/allowed' and c.get('Env') == []
            and c.get('Healthcheck') == {'Test': ['NONE']}
            and type(c.get('StopTimeout')) is int and c['StopTimeout'] == 2
            and c.get('Volumes') in (None, {})):
        return False
    driver, allowed = paths(value)
    mounts = inspected.get('Mounts')
    if type(mounts) is not list or len(mounts) != 2:
        return False
    expected_mounts = {(driver, '/driver/probe.py'): False, (allowed, '/allowed'): True}
    seen = set()
    for mount in mounts:
        if type(mount) is not dict:
            return False
        key = (mount.get('Source'), mount.get('Destination'))
        if not all(isinstance(k, str) for k in key) or key not in expected_mounts or key in seen:
            return False
        if mount.get('Type') != 'bind' or mount.get('RW') is not expected_mounts[key] or mount.get('Propagation') != 'rprivate':
            return False
        seen.add(key)
    return len(seen) == 2


def initial(value):
    return {'config': config(value), 'phase': 'INTENT_RECORDED', 'container_id': None}


def simulate(state, event, observation=None):
    """Pure ordering model, never a trusted observation/dispatch interface.

Each send occupies its phase BEFORE accepting an outcome. Missing, malformed,
timed-out or interrupted outcomes become sticky UNKNOWN, never a second create.
    Real authorization, persistence and live inspection are NOT supplied by this
    model. An executor must not treat a successful transition as permission.
"""
    if type(state) is not dict or set(state) != {'config', 'phase', 'container_id'}:
        raise Denied('Invalid model state')
    if not isinstance(event, str):
        raise Denied('Invalid model event')
    value = config(state['config'])
    phase, identity = state['phase'], state['container_id']
    if not isinstance(phase, str) or phase not in PHASES:
        raise Denied('Invalid phase')
    if identity is not None:
        container_id(identity)
    if phase not in {'INTENT_RECORDED', 'CREATE_SENT', 'UNKNOWN'} and identity is None:
        raise Denied('Missing exact container identity')
    if phase in {'INTENT_RECORDED', 'CREATE_SENT'} and identity is not None:
        raise Denied('Premature container identity')
    next_state = {'config': value, 'phase': phase, 'container_id': identity}
    output = {'state': next_state, 'planned_argv': None, **BOUNDARY}
    if phase == 'UNKNOWN':
        # Even a subsequently supplied successful observation cannot self-reconcile.
        return output
    if event in {'timeout', 'interrupted', 'persistence_failure', 'revoked', 'invalid_observation'}:
        next_state['phase'] = 'UNKNOWN'
        return output
    sends = {
        ('INTENT_RECORDED', 'send_create'): ('CREATE_SENT', create_argv(value)),
        ('INSPECTED', 'send_start'): ('START_SENT', fixed_argv('start', identity)) if identity else None,
        ('STOP_INTENT', 'send_stop'): ('STOP_SENT', fixed_argv('stop', identity)) if identity else None,
        ('STOP_SENT', 'send_wait'): ('WAIT_SENT', fixed_argv('wait', identity)) if identity else None,
    }
    if (phase, event) in sends:
        if observation is not None:
            raise Denied('Send cannot contain an outcome')
        next_state['phase'], output['planned_argv'] = sends[(phase, event)]
    elif phase == 'CREATE_SENT' and event == 'created':
        try:
            next_state['container_id'] = container_id(observation)
            next_state['phase'] = 'CREATED'
            output['planned_argv'] = fixed_argv('inspect', observation)
        except Denied:
            next_state['phase'] = 'UNKNOWN'
    elif phase == 'CREATED' and event == 'inspected':
        next_state['phase'] = 'INSPECTED' if prestart(value, identity, observation) else 'UNKNOWN'
    elif phase == 'START_SENT' and event == 'started':
        if (type(observation) is not dict or observation.get('Id') != identity
                or type(observation.get('State')) is not dict
                or observation['State'].get('Running') is not True
                or observation['State'].get('Status') != 'running'
                or type(observation['State'].get('Pid')) is not int
                or observation['State']['Pid'] <= 0):
            next_state['phase'] = 'UNKNOWN'
        else:
            next_state['phase'] = 'RUNNING'
    elif phase in {'CREATED', 'INSPECTED', 'START_SENT', 'RUNNING'} and event == 'record_stop_intent':
        if observation is not None:
            raise Denied('STOP Intent is distinct from its outcome')
        next_state['phase'] = 'STOP_INTENT'
    elif phase == 'WAIT_SENT' and event == 'finished':
        valid = (type(observation) is dict and set(observation) == {'wait_exit_code', 'inspection'}
                 and type(observation['wait_exit_code']) is int and 0 <= observation['wait_exit_code'] <= 255
                 and stopped(observation['inspection'], identity)
                 and type(observation['inspection']['State'].get('ExitCode')) is int
                 and observation['inspection']['State']['ExitCode'] == observation['wait_exit_code'])
        next_state['phase'] = 'STOPPED' if valid else 'UNKNOWN'
    else:
        raise Denied('Out-of-order or repeated dispatch refused')
    return output


def unlinked(path):
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.is_symlink() or (hasattr(item, 'is_junction') and item.is_junction()):
            raise Denied('Linked evidence path refused')
    return path


def prepare(value):
    value = config(value)
    if hashlib.sha256(PROBE.read_bytes()).hexdigest() != PROBE_SHA256:
        raise Denied('Frozen probe digest changed')
    root = unlinked(BASE / 'work')
    root.mkdir(exist_ok=True)
    folder = unlinked(root / value['run_key'])
    # Atomic reservation. Any previous bytes, including damaged evidence, prevent
    # redispatch. No result/identity is accepted from an old local file.
    try:
        folder.mkdir()
    except FileExistsError:
        return {'status': 'UNKNOWN', 'reason': 'Existing reservation; never redispatch', **BOUNDARY}
    try:
        intent = {'status': 'PREPARED_NOT_EXECUTED', 'config': value,
                  'probe_sha256': PROBE_SHA256,
                  'candidate_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'planned_image_inspect': [DOCKER, 'image', 'inspect', value['image']],
                  'planned_create_argv': create_argv(value),
                  'remote_sink_satisfied': False, 'formal_prerequisites_satisfied': False,
                  'actual_linux_staging_performed': False, **BOUNDARY}
        target = folder / 'intent.json'
        with target.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(intent, stream, sort_keys=True, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        if json.loads(target.read_text(encoding='utf-8')) != intent:
            raise Denied('Intent read-back mismatch')
        return intent
    except (OSError, ValueError):
        return {'status': 'UNKNOWN', 'reason': 'Reservation retained after Intent failure', **BOUNDARY}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare', 'run', 'formal'])
    parser.add_argument('--config', type=Path)
    args = parser.parse_args(argv)
    try:
        if args.operation != 'prepare':
            raise Denied('No executor: actual Profile/GA/store/vector/host/image/budget and inspect/STOP evidence are absent')
        if args.config is None:
            raise Denied('Explicit synthetic config required')
        result = prepare(json.loads(args.config.read_text(encoding='utf-8')))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['status'] == 'PREPARED_NOT_EXECUTED' else 2
    except (Denied, OSError, ValueError) as exc:
        print(json.dumps({'status': 'BLOCKED', 'reason': str(exc), **BOUNDARY}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
