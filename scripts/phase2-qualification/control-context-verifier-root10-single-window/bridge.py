"""Fixed internal Python port for the trusted same-process admission entry.

This module is not an authorization verifier. Only that accepted entry may call
it after fresh currentness verification. No caller-supplied authorization flags,
commands, paths, environment or arbitrary executable interface are accepted.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

BASE = Path(__file__).resolve().parent
HOST = BASE / 'fixed_host.py'
HOST_SHA = '68059fec260acd6a6671315cf93f65c54616e4edfa3377ee25066b01b46f4259'
MAX_INPUT = 131072
BOUNDARY = {'qualified': False, 'capacity_released': False, 'authority_effect': 'NONE',
            'remote_result_persisted': False, 'automatic_retry': False}


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('Duplicate JSON key')
        value[key] = item
    return value


def parse(raw):
    if type(raw) is not bytes or len(raw) > MAX_INPUT:
        raise ValueError('Bounded exact input required')
    value = json.loads(raw, object_pairs_hook=unique)
    base_fields = {'operation', 'nonce', 'ga_raw', 'ga_sha256', 'container_id'}
    if type(value) is not dict or set(value) not in (base_fields, base_fields | {'temporal_continuation'}):
        raise ValueError('Fixed input fields required')
    if value['operation'] not in ('CREATE', 'START', 'STOP', 'INSPECT'):
        raise ValueError('Fixed operation required')
    if type(value['nonce']) is not str or not re.fullmatch('[0-9a-f]{32}', value['nonce']):
        raise ValueError('Exact synthetic nonce required')
    ga_raw = value['ga_raw']
    if type(ga_raw) is not str or len(ga_raw.encode('utf-8')) > 65536:
        raise ValueError('Bounded complete GA bytes required')
    ga = json.loads(ga_raw, object_pairs_hook=unique)
    if type(ga) is not dict or type(ga.get('gate_authorization_id')) is not str:
        raise ValueError('Complete GA object required; engineering requests excluded')
    if value['ga_sha256'] != hashlib.sha256(ga_raw.encode('utf-8')).hexdigest():
        raise ValueError('Exact GA bytes changed')
    if 'temporal_continuation' in value:
        temporal = value['temporal_continuation']
        # Two accepted separate-authority shapes: the temporal continuation, and
        # the runtime-clock amendment whose host_window bounds the container life.
        # The scope amendment that carries that clock forward uses the second shape
        # unchanged; which amendment a host_window payload is, and the 600 seconds
        # it must bound, are settled by parent600, not by this shape check.
        if type(temporal) is not dict or set(temporal) not in ({'raw', 'sha256', 'event'},
                                                               {'raw', 'sha256', 'event', 'host_window'}):
            raise ValueError('Exact separate temporal material required')
    if value['operation'] == 'CREATE':
        if value['container_id'] is not None:
            raise ValueError('CREATE cannot target an existing container')
    elif type(value['container_id']) is not str or not re.fullmatch('[0-9a-f]{64}', value['container_id']):
        raise ValueError('Exact existing container required')
    return value


def load_host():
    if hashlib.sha256(HOST.read_bytes()).hexdigest() != HOST_SHA:
        raise ValueError('Accepted fixed host bytes changed')
    spec = importlib.util.spec_from_file_location('trusted_fixed_host_port', HOST)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def dispatch(value, h):
    operation, nonce, ga_sha = value['operation'], value['nonce'], value['ga_sha256']
    container = value['container_id']
    started_utc = h.observation.utc()
    # CREATE preparation uses CreateNew; an existing or damaged reservation
    # refuses here. START's exact local intent is also CreateNew before dispatch.
    if operation == 'CREATE':
        h.prepare(nonce, value['ga_raw'], value.get('temporal_continuation'))
    port = h.FixedHost(nonce, ga_sha)
    if port.temporal != value.get('temporal_continuation'):
        raise ValueError('Exact original temporal host input changed')
    h.observation.persist(port.folder, 'bridge-' + operation.lower() + '-once.json',
                          {'ga_sha256': ga_sha, 'container_id': container, **BOUNDARY})
    if operation == 'CREATE':
        container = port.create_fixed()
        # Read the exact already persisted Docker response, without another CLI.
        observation = h.observation.load_record(port.folder / 'main-created-inspect.stdout')[0]
    elif operation == 'START':
        guard = port.arm_watchdog(container)
        port.start_exact(container, guard)
        observation = port.inspect(container, 'bridge-running-inspect')
        if observation.get('State', {}).get('Running') is not True:
            raise ValueError('Actual running state not observed')
    elif operation == 'STOP':
        observation = port.stop_exact(container)
    else:
        observation = port.inspect(container, 'bridge-inspect')
    result = {'state': 'ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT',
              'operation': operation, 'ga_sha256': ga_sha, 'container_id': container,
              'observation': observation, 'started_utc': started_utc,
              'ended_utc': h.observation.utc(), **BOUNDARY}
    if operation == 'START':
        result['guard_pid'] = guard.pid
    h.observation.persist(port.folder, 'bridge-' + operation.lower() + '-result.json', result)
    return result


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('No command-line configuration accepted')
        value = parse(sys.stdin.buffer.read(MAX_INPUT + 1))
        result = dispatch(value, load_host())
    except Exception as exc:
        result = {'state': 'UNKNOWN', 'reason': type(exc).__name__, **BOUNDARY}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['state'] == 'ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT' else 2


if __name__ == '__main__':
    raise SystemExit(main())
