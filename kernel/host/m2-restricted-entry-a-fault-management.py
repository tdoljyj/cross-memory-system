"""Root-only fixed management batch; never an Agent tool or general launcher.

The approved normal A package is unchanged. This companion needs separate exact
installation and fault approval. Every result retains NOT_ISSUED qualification.
"""
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import stat
import sys
import time
import types

CODE = Path('/usr/local/lib/clued-m2-a-fault-fixture')
CONFIG = Path('/etc/clued-m2-a-fault')
LOG = Path('/var/log/clued-m2-a-fault')
BASE = Path('/usr/local/lib/clued-m2-a')
VM_ID = '9d775385-4546-4450-a77f-08cdf4f696b6'
INSTANCE = 'm2-a-public-empty-20261003'
CASES = ('timeout', 'revoke', 'disconnect')
REQUEST_IDS = {case: 'm2-fault-20261004-' + case + '-01' for case in CASES}
CODE_FILES = ('fault_fixture.py', 'fault_observer.py', 'management.py', 'base_installer.py')
MAX_FRAME = 98304
LEASE = 60.0


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('DUPLICATE_KEY')
        result[key] = value
    return result


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('ascii')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def owned(path, mode, directory=False):
    for parent in reversed(path.parents):
        item = parent.lstat()
        if not stat.S_ISDIR(item.st_mode) or item.st_uid != 0 or item.st_mode & 0o022:
            raise ValueError('PARENT_INVALID')
    item = path.lstat()
    valid = stat.S_ISDIR if directory else stat.S_ISREG
    if (not valid(item.st_mode) or item.st_uid != 0 or item.st_gid != 0 or
            stat.S_IMODE(item.st_mode) != mode or (not directory and item.st_nlink != 1)):
        raise ValueError('IDENTITY_INVALID')
    return dict(device=item.st_dev, inode=item.st_ino, uid=item.st_uid,
                gid=item.st_gid, mode=stat.S_IMODE(item.st_mode))


def read_owned(path, mode=0o600):
    before = owned(path, mode)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        item = os.fstat(stream.fileno())
        if (item.st_dev, item.st_ino, item.st_uid, item.st_gid, stat.S_IMODE(item.st_mode)) != tuple(
                before[k] for k in ('device', 'inode', 'uid', 'gid', 'mode')):
            raise ValueError('READ_IDENTITY_DRIFT')
        raw = stream.read(MAX_FRAME + 1)
    if len(raw) > MAX_FRAME or owned(path, mode) != before:
        raise ValueError('READ_IDENTITY_DRIFT')
    return raw


def load(name, path, source):
    # Execute exactly the already verified source snapshot. Disabling cache
    # writes alone would still permit loading stale/unapproved existing .pyc.
    module = types.ModuleType(name)
    module.__file__ = str(path)
    sys.modules[name] = module
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        exec(compile(source, str(path), 'exec'), module.__dict__)
    finally:
        sys.dont_write_bytecode = previous
    return module


def validate_profile(profile):
    keys = {'schema', 'instance', 'vm_id', 'files', 'base_receipt_sha256',
            'request_ids', 'binding', 'log_directory_identity'}
    if (type(profile) is not dict or set(profile) != keys or
            profile['schema'] != 'm2-a-fault-installed-v1' or profile['instance'] != INSTANCE or
            profile['vm_id'] != VM_ID or profile['request_ids'] != REQUEST_IDS or
            type(profile['files']) is not dict or set(profile['files']) != set(CODE_FILES)):
        raise ValueError('FAULT_PROFILE_INVALID')
    hashes = list(profile['files'].values()) + [profile['base_receipt_sha256']]
    if any(type(v) is not str or len(v) != 64 or any(c not in '0123456789abcdef' for c in v) for v in hashes):
        raise ValueError('FAULT_PROFILE_INVALID')
    binding = profile['binding']
    if (type(binding) is not dict or set(binding) != {'uid', 'gid', 'input', 'output'} or
            any(type(binding[k]) is not int or binding[k] <= 0 for k in ('uid', 'gid')) or
            any(type(binding[k]) is not list or len(binding[k]) != 2 or
                any(type(v) is not int or v < 0 for v in binding[k]) for k in ('input', 'output'))):
        raise ValueError('FAULT_PROFILE_INVALID')
    return profile


def installed():
    if sys.platform != 'linux' or os.geteuid() != 0 or Path(__file__).resolve() != CODE / 'management.py':
        raise ValueError('NOT_CONFIGURED')
    owned(CODE, 0o755, True)
    owned(CONFIG, 0o700, True)
    raw = read_owned(CONFIG / 'profile.json')
    profile = validate_profile(json.loads(raw, object_pairs_hook=unique))
    receipt = json.loads(read_owned(LOG / 'install-receipt.json'), object_pairs_hook=unique)
    expected = {'schema', 'manifest_sha256', 'profile_sha256', 'identities', 'base_receipt',
                'base_receipt_sha256', 'base_ledger_identity', 'installation_id'}
    if (type(receipt) is not dict or set(receipt) != expected or
            receipt['schema'] != 'm2-a-fault-install-receipt-v1' or
            receipt['installation_id'] != sha(encoded({k: v for k, v in receipt.items() if k != 'installation_id'})) or
            receipt['profile_sha256'] != sha(raw) or receipt['base_receipt_sha256'] != profile['base_receipt_sha256']):
        raise ValueError('FAULT_RECEIPT_INVALID')
    identities = {'code_directory': owned(CODE, 0o755, True),
                  'config_directory': owned(CONFIG, 0o700, True),
                  'log_directory': owned(LOG, 0o700, True),
                  'profile.json': owned(CONFIG / 'profile.json', 0o600)}
    code_bytes = {}
    for name in CODE_FILES:
        identities[name] = owned(CODE / name, 0o555)
        code_bytes[name] = read_owned(CODE / name, 0o555)
        if sha(code_bytes[name]) != profile['files'][name]:
            raise ValueError('FAULT_CODE_DRIFT')
    if identities != receipt['identities'] or profile['log_directory_identity'] != identities['log_directory']:
        raise ValueError('FAULT_IDENTITY_DRIFT')
    strict = load('fault_base_installer', CODE / 'base_installer.py', code_bytes['base_installer.py'])
    retained = strict.retained_snapshot()
    head_name, head, head_raw = strict.receipt_head(retained)
    strict.check_history(retained, head)
    if (head_name != receipt['base_receipt'] or sha(head_raw) != profile['base_receipt_sha256'] or
            retained['files']['ledger.sqlite'][0] != receipt['base_ledger_identity']):
        raise ValueError('BASE_HISTORY_DRIFT')
    # Validate the normal package before importing its executor, not just after.
    normal = json.loads(read_owned(strict.CONFIG / 'profile.json'), object_pairs_hook=unique)
    if (set(normal) != {'schema', 'instance', 'frozen_inputs', 'files', 'binding'} or
            normal['schema'] != 'm2-a-installed-v1' or normal['instance'] != INSTANCE or
            normal['binding'] != profile['binding'] or set(normal['files']) != {'executor.py', 'boundary.py', 'empty_probe.py'} or
            sha(encoded(normal)) != head['profile_sha256']):
        raise ValueError('BASE_PROFILE_DRIFT')
    normal_bytes = {}
    for name, digest in normal['files'].items():
        normal_bytes[name] = read_owned(BASE / name, 0o555)
        if sha(normal_bytes[name]) != digest:
            raise ValueError('BASE_CODE_DRIFT')
    base = load('fault_base_executor', BASE / 'executor.py', normal_bytes['executor.py'])
    observer = load('fault_installed_observer', CODE / 'fault_observer.py', code_bytes['fault_observer.py'])
    return base, observer, strict, profile


def receive(conn, deadline):
    data = bytearray()
    while len(data) <= MAX_FRAME:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('FRAME_DEADLINE')
        conn.settimeout(remaining)
        value = conn.recv(1)
        if not value:
            raise EOFError('TRANSPORT_CLOSED')
        data.extend(value)
        if value == b'\n':
            return json.loads(data, object_pairs_hook=unique)
    raise ValueError('FRAME_TOO_LARGE')


def control_frame(value, action, request_id=None):
    expected = {'action': action}
    if request_id is not None:
        expected['request_id'] = request_id
    if type(value) is not dict or value != expected or set(value) != set(expected):
        raise ValueError('FIXED_MANAGEMENT_FRAME_REQUIRED')


def send(conn, value):
    raw = encoded(value)
    if len(raw) > MAX_FRAME:
        raise ValueError('FRAME_TOO_LARGE')
    conn.sendall(raw)


def runner_type(base, observer):
    class FixedFaultRunner(base.CgroupRunner):
        def __init__(self, binding, case, conn, verify_fixture):
            if case not in CASES:
                raise ValueError('FIXED_CASE_REQUIRED')
            super().__init__(binding)
            self.case, self.conn, self.verify_fixture = case, conn, verify_fixture
            self.before, self.trigger_actual, self.stop_result = None, None, None
            self.native_proof, self.stop_elapsed, self.cached_proof = {}, None, None
            self.trigger_monotonic = None
            self.launch_deadline = None

        def command(self, tool):
            if tool != base.TOOLS[2]:
                raise ValueError('MANAGEMENT_FIXTURE_ONLY')
            self.verify_fixture()
            if self.launch_deadline is None or time.monotonic() >= self.launch_deadline:
                raise TimeoutError('ENTRY_LEASE_EXPIRED')
            return observer.FIXED_COMMAND

        def run(self, tool, payload, deadline, interrupted):
            self.launch_deadline = deadline
            def management_interrupt():
                if interrupted():
                    return True
                if self.process is None:
                    return False
                if self.before is None:
                    try:
                        candidate = observer.observe(observer.bind_started_group(self.process.pid))
                        if observer.ready(candidate) and all(x.uid == self.uid and x.gid == self.gid for x in candidate.members):
                            self.before = candidate
                            send(self.conn, {'schema': 'm2-a-fault-ready-v1', 'request_id': REQUEST_IDS[self.case],
                                             'qualification': 'NOT_ISSUED', 'ready': True})
                    except (OSError, ValueError, observer.Uncertain):
                        pass  # Missing readiness can only produce UNKNOWN.
                if time.monotonic() >= deadline:
                    self.trigger_actual = 'timeout'
                    self.trigger_monotonic = deadline
                    return True
                readable, _, _ = select.select([self.conn], [], [], 0)
                if not readable:
                    return False
                if self.conn.recv(1, socket.MSG_PEEK) == b'':
                    self.trigger_actual = 'disconnect'
                    self.trigger_monotonic = time.monotonic()
                    return True
                control_frame(receive(self.conn, deadline), 'revoke', REQUEST_IDS[self.case])
                if self.case != 'revoke' or self.before is None:
                    raise ValueError('UNEXPECTED_CONTROL')
                self.trigger_actual = 'revoke'
                self.trigger_monotonic = time.monotonic()
                return True
            return super().run(tool, payload, deadline, management_interrupt)

        def stop(self, timeout):
            if self.cached_proof is not None:
                return self.cached_proof
            start = time.monotonic()
            def native_stop(bound):
                self.native_proof = super(FixedFaultRunner, self).stop(bound)
                return self.native_proof
            if self.before is None:
                native_stop(timeout)
                self.stop_result = {'execution_state': 'UNKNOWN', 'qualification': 'NOT_ISSUED', 'observation': None}
            else:
                self.stop_result = observer.stop_and_observe(types.SimpleNamespace(stop=native_stop), self.before, timeout)
            self.stop_elapsed = time.monotonic() - start
            self.trigger_to_observation = (time.monotonic() - self.trigger_monotonic
                                           if self.trigger_monotonic is not None else None)
            self.cached_proof = (self.native_proof if self.stop_result['execution_state'] == 'STOPPED' and
                                 0 <= self.stop_elapsed < base.STOP_TIMEOUT and
                                 self.trigger_to_observation is not None and
                                 0 <= self.trigger_to_observation < base.STOP_TIMEOUT else {})
            return self.cached_proof
    return FixedFaultRunner


def case_record(runner, result):
    after = runner.stop_result['observation'] if runner.stop_result is not None else None
    confirmed = (runner.before is not None and runner.trigger_actual == runner.case and
                 result.get('execution_state') == 'STOPPED' and runner.cached_proof)
    return {'schema': 'm2-a-fault-case-observation-v1', 'case': runner.case,
            'request_id': REQUEST_IDS[runner.case], 'qualification': 'NOT_ISSUED',
            'scenario_status': 'CONFIRMED_OBSERVATIONS' if confirmed else 'UNKNOWN',
            'execution_state': result.get('execution_state', 'UNKNOWN'),
            'trigger_actual': runner.trigger_actual, 'stop_elapsed_seconds': runner.stop_elapsed,
            'trigger_to_observation_seconds': getattr(runner, 'trigger_to_observation', None),
            'before': asdict(runner.before) if runner.before is not None else None,
            'after': asdict(after) if after is not None else None, 'native_proof': runner.native_proof}


def write_record(strict, profile, record):
    if strict.identity(LOG, 0o700, True) != profile['log_directory_identity']:
        raise ValueError('LOG_IDENTITY_DRIFT')
    strict.exclusive(LOG / (record['request_id'] + '.json'), encoded(record), 0o600)


def summary():
    base, observer, strict, profile = installed()
    records = []
    for case in CASES:
        row = json.loads(read_owned(LOG / (REQUEST_IDS[case] + '.json')), object_pairs_hook=unique)
        if (type(row) is not dict or row.get('schema') != 'm2-a-fault-case-observation-v1' or
                row.get('case') != case or row.get('request_id') != REQUEST_IDS[case] or row.get('qualification') != 'NOT_ISSUED'):
            raise ValueError('CASE_LOG_INVALID')
        records.append(row)
    return {'schema': 'm2-a-fault-batch-observation-v1', 'qualification': 'NOT_ISSUED',
            'batch_status': 'OBSERVATIONS_COMPLETE' if all(r['scenario_status'] == 'CONFIRMED_OBSERVATIONS' for r in records) else 'UNKNOWN',
            'cases': records}


def serve():
    base, observer, strict, profile = installed()
    if not hasattr(socket, 'AF_VSOCK') or not hasattr(socket, 'VMADDR_CID_HOST'):
        raise ValueError('TRANSPORT_UNAVAILABLE')
    native = base.installed_executor()
    deadline = native.started + base.LEASE
    listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    try:
        listener.bind((socket.VMADDR_CID_ANY, base.PORT))
        listener.listen(1)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('ENTRY_LEASE_EXPIRED')
        listener.settimeout(remaining)
        conn, peer = listener.accept()
        with conn:
            if peer[0] != socket.VMADDR_CID_HOST:
                raise ValueError('PEER_INVALID')
            kind = runner_type(base, observer)
            for case in CASES:
                control_frame(receive(conn, deadline), 'start', REQUEST_IDS[case])
                # Revalidate fixed installed source and identities before launch.
                def verify_fixture():
                    current = installed()[3]
                    if current != profile:
                        raise ValueError('PROFILE_DRIFT')
                runner = kind(profile['binding'], case, conn, verify_fixture)
                entry = base.Executor(native.ledger, runner, INSTANCE, native.frozen)
                # The batch owns one original lease; new case objects do not
                # refresh it. Executor's original deadline checks remain intact.
                entry.started = native.started
                entry.clock = native.clock
                # The normal Executor burns this same-instance ID before launch.
                result = entry.call(base.TOOLS[2], {'request_id': REQUEST_IDS[case]})
                row = case_record(runner, result)
                write_record(strict, profile, row)
                print(encoded(row).decode('ascii'), end='', flush=True)
                if case != 'disconnect':
                    send(conn, row)
                if row['scenario_status'] != 'CONFIRMED_OBSERVATIONS':
                    raise ValueError('FAULT_OBSERVATION_UNKNOWN')
        # One planned audit-only connection after real disconnect, never a retry
        # of a fault. It returns only the three fixed root-owned observation logs.
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('ENTRY_LEASE_EXPIRED')
        listener.settimeout(remaining)
        audit, peer = listener.accept()
        with audit:
            if peer[0] != socket.VMADDR_CID_HOST:
                raise ValueError('PEER_INVALID')
            control_frame(receive(audit, deadline), 'collect-fixed-summary')
            send(audit, summary())
    finally:
        listener.close()
        native.ledger.close()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv not in (['--run-fixed-batch'], ['--summarize-fixed-batch']):
        print('{"status":"deny","error_code":"NOT_CONFIGURED","qualification":"NOT_ISSUED"}')
        return 2
    try:
        if argv == ['--run-fixed-batch']:
            serve()
        else:
            print(encoded(summary()).decode('ascii'), end='')
        return 0
    except Exception:
        print('{"status":"deny","error_code":"FAULT_BATCH_UNKNOWN_PRESERVE","qualification":"NOT_ISSUED"}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
