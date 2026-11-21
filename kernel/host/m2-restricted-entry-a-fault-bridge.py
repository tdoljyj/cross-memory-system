"""Trusted management only: one fixed fault batch and one audit connection.

No Agent tools, arbitrary command, role, root, case or request override exists.
CID/port remain routing only; the whole management host is trusted, unqualified.
"""
import hashlib
import json
import math
from pathlib import Path
import socket
import sys
import time
import uuid

VM_ID = '9d775385-4546-4450-a77f-08cdf4f696b6'
SERVICE_ID = '0000ac45-facb-11e6-bd58-64006a7986d3'
PROFILE = Path(r'C:\Program Files\CluedM2Fault\host-a\fault-profile.json')
CASES = ('timeout', 'revoke', 'disconnect')
REQUEST_IDS = {case: 'm2-fault-20261004-' + case + '-01' for case in CASES}
MAX_FRAME = 98304
STOP_TIMEOUT = 0.1


def unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('DUPLICATE_KEY')
        value[key] = item
    return value


def send(conn, value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')
    if len(raw) > MAX_FRAME:
        raise ValueError('FRAME_TOO_LARGE')
    conn.sendall(raw)


def receive(conn):
    raw = bytearray()
    while len(raw) <= MAX_FRAME:
        value = conn.recv(1)
        if not value:
            raise EOFError('TRANSPORT_CLOSED')
        raw.extend(value)
        if value == b'\n':
            return json.loads(raw, object_pairs_hook=unique)
    raise ValueError('FRAME_TOO_LARGE')


def validate_profile(value):
    if (type(value) is not dict or set(value) != {'schema', 'vm_id', 'service_id', 'bridge_sha256', 'request_ids'} or
            value['schema'] != 'm2-a-fault-bridge-v1' or value['vm_id'] != VM_ID or
            value['service_id'] != SERVICE_ID or value['request_ids'] != REQUEST_IDS or
            type(value['bridge_sha256']) is not str or len(value['bridge_sha256']) != 64 or
            any(x not in '0123456789abcdef' for x in value['bridge_sha256'])):
        raise ValueError('PROFILE_INVALID')
    return value


def connect_installed():
    # The separately approved host installer pins code/profile/parent ACLs.
    if sys.platform != 'win32' or not hasattr(socket, 'AF_HYPERV') or PROFILE.is_symlink():
        raise ValueError('NOT_CONFIGURED')
    with PROFILE.open('rb') as stream:
        raw = stream.read(MAX_FRAME + 1)
    if len(raw) > MAX_FRAME:
        raise ValueError('PROFILE_INVALID')
    profile = validate_profile(json.loads(raw, object_pairs_hook=unique))
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != profile['bridge_sha256']:
        raise ValueError('CODE_DRIFT')
    conn = socket.socket(socket.AF_HYPERV, socket.SOCK_STREAM, socket.HV_PROTOCOL_RAW)
    try:
        conn.settimeout(1.2)  # Existing A bridge transport bound, unchanged.
        conn.connect((VM_ID, SERVICE_ID))
        return conn
    except BaseException:
        conn.close()
        raise


def generation(member):
    return tuple(member[k] for k in ('pid', 'start_ticks', 'pgid', 'session', 'uid', 'gid'))


def validate_member(member):
    keys = {'pid', 'start_ticks', 'pgid', 'session', 'uid', 'gid', 'state'}
    if (type(member) is not dict or set(member) != keys or
            any(type(member[k]) is not int or member[k] <= 0 for k in keys - {'state'}) or
            type(member['state']) is not str or len(member['state']) != 1 or
            member['state'] not in 'RSDZTtXxKWPI'):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')


def validate_case(row, case):
    expected = {'schema', 'case', 'request_id', 'qualification', 'scenario_status', 'execution_state',
                'trigger_actual', 'stop_elapsed_seconds', 'trigger_to_observation_seconds',
                'before', 'after', 'native_proof'}
    if (type(row) is not dict or set(row) != expected or row['schema'] != 'm2-a-fault-case-observation-v1' or
            row['case'] != case or row['request_id'] != REQUEST_IDS[case] or row['qualification'] != 'NOT_ISSUED' or
            row['scenario_status'] != 'CONFIRMED_OBSERVATIONS' or row['execution_state'] != 'STOPPED' or
            row['trigger_actual'] != case):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')
    for key in ('stop_elapsed_seconds', 'trigger_to_observation_seconds'):
        value = row[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < STOP_TIMEOUT:
            raise ValueError('CASE_OBSERVATION_UNKNOWN')
    proof = row['native_proof']
    if (type(proof) is not dict or set(proof) != {'scope', 'cgroup_empty', 'leader_reaped', 'identity_unchanged'} or
            proof['scope'] != 'entire_cgroup' or any(proof[k] is not True for k in
               ('cgroup_empty', 'leader_reaped', 'identity_unchanged'))):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')
    before, after = row['before'], row['after']
    if (type(before) is not dict or type(after) is not dict or
            set(before) != {'binding', 'members', 'tracked', 'complete', 'reason'} or set(after) != set(before) or
            before['complete'] is not True or after['complete'] is not True or before['binding'] != after['binding'] or
            type(before['members']) is not list or type(after['members']) is not list or
            type(after['tracked']) is not list or len(before['members']) < 2 or
            len(after['tracked']) != len(before['members'])):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')
    binding = before['binding']
    if (type(binding) is not dict or set(binding) != {'boot_id', 'leader'} or
            type(binding['boot_id']) is not str or str(uuid.UUID(binding['boot_id'])) != binding['boot_id'] or
            before['tracked'] != [] or before['reason'] != '' or after['reason'] != ''):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')
    leader = before['binding']['leader']
    validate_member(leader)
    for member in before['members'] + after['members'] + [x for x in after['tracked'] if x is not None]:
        validate_member(member)
    identities = [generation(member) for member in before['members']]
    if (len(identities) != len(set(identities)) or leader['pid'] != leader['pgid'] or
            leader['pid'] != leader['session'] or leader['uid'] <= 0 or leader['gid'] <= 0 or
            not any(generation(x) == generation(leader) and x['state'] not in 'ZXx' for x in before['members']) or
            not any(x['pid'] != leader['pid'] and x['state'] not in 'ZXx' for x in before['members']) or
            any((x['pgid'], x['session'], x['uid'], x['gid']) !=
                (leader['pgid'], leader['session'], leader['uid'], leader['gid']) for x in before['members'])):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')
    for old, current in zip(before['members'], after['tracked']):
        if current is not None and (generation(current) != generation(old) or current['state'] not in 'ZXx'):
            raise ValueError('CASE_OBSERVATION_UNKNOWN')
    if any(x['state'] not in 'ZXx' or
           (x['pgid'], x['session'], x['uid'], x['gid']) !=
           (leader['pgid'], leader['session'], leader['uid'], leader['gid']) for x in after['members']):
        raise ValueError('CASE_OBSERVATION_UNKNOWN')
    return row


def validate_summary(value):
    if (type(value) is not dict or set(value) != {'schema', 'qualification', 'batch_status', 'cases'} or
            value['schema'] != 'm2-a-fault-batch-observation-v1' or value['qualification'] != 'NOT_ISSUED' or
            value['batch_status'] != 'OBSERVATIONS_COMPLETE' or type(value['cases']) is not list or len(value['cases']) != 3):
        raise ValueError('BATCH_OBSERVATION_UNKNOWN')
    for case, row in zip(CASES, value['cases']):
        validate_case(row, case)
    return value


def run_batch(connect=connect_installed):
    host_events = []
    conn = connect()
    try:
        for case in CASES:
            send(conn, {'action': 'start', 'request_id': REQUEST_IDS[case]})
            ready = receive(conn)
            if ready != {'schema': 'm2-a-fault-ready-v1', 'request_id': REQUEST_IDS[case],
                          'qualification': 'NOT_ISSUED', 'ready': True} or ready['ready'] is not True:
                raise ValueError('READINESS_UNKNOWN')
            if case == 'revoke':
                host_events.append({'case': case, 'host_monotonic': time.monotonic(), 'action': 'revoke-sent'})
                send(conn, {'action': 'revoke', 'request_id': REQUEST_IDS[case]})
            elif case == 'disconnect':
                host_events.append({'case': case, 'host_monotonic': time.monotonic(), 'action': 'actual-socket-close'})
                conn.close()
                conn = None
                break
            validate_case(receive(conn), case)
    finally:
        if conn is not None:
            conn.close()
    # Exactly one predeclared independent audit connection, no fault retry.
    audit = connect()
    try:
        send(audit, {'action': 'collect-fixed-summary'})
        result = validate_summary(receive(audit))
    finally:
        audit.close()
    # Root and host monotonic clocks are different domains. Do not subtract them
    # to fabricate end-to-end Host revoke/disconnect latency qualification.
    return result, host_events


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv != ['--run-fixed-batch']:
        print('{"status":"deny","error_code":"NOT_CONFIGURED","qualification":"NOT_ISSUED"}')
        return 2
    try:
        result, events = run_batch()
        # The sole stdout result is the independently collected root summary;
        # event timings are audit-only stderr, not a transport completion proof.
        print(json.dumps({'host_events': events, 'qualification': 'NOT_ISSUED'}), file=sys.stderr)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception:
        print('{"status":"deny","error_code":"FAULT_TRANSPORT_UNKNOWN_PRESERVE","qualification":"NOT_ISSUED"}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
